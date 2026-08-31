# Cut the aux grace to 20s, and show the waiting DJ a countdown

**Date:** 2026-08-23
**Status:** approved, not yet deployed

## What and why

Two changes, one user-visible outcome.

1. `AUX_GRACE` drops from **45s to 20s**. Every second of it is a second the
   next DJ waits after the previous one is genuinely done, and 45s was chosen
   before anyone had stood in a room waiting it out.
2. The waiting banner gains a **live countdown**, so a blocked player can see
   how long they are blocked for instead of guessing.

The banner already renders only for `you_are_waiting`, so the countdown reaches
exactly the people who do not have the aux and nobody else.

## The state a waiting player is actually in

`aux_state()` currently reports the **routed** phone — `self._aux_path` — and
never consults `_holder(now())`. Those two disagree for the whole length of the
grace after it lapses: the speaker is still filtered to Jake's phone, but Jake
is no longer entitled to it and anyone who presses play takes it. The site says
"Jake has the aux" throughout, which is the single most misleading thing it can
say to the person waiting.

So the holder payload gains one field, a deliberate tri-state:

| `free_in_ms` | Pi state | Banner |
|---|---|---|
| `null` | A play is open. Music is on; no honest deadline exists. | "Jake has the aux. Press play once they're done and it's yours." |
| `> 0` | Play closed, grace running out. | "Jake has the aux — yours in 12s" |
| `0` | Grace lapsed, Jake still connected. | "The aux is free — press play." |

`null` rather than a number while a song plays is the load-bearing part. See
"The countdown must never rewind" below.

## The countdown must never rewind

`AUX_GRACE` restarts on **any** holder activity. A naive countdown therefore
ticks down and jumps back up, which is exactly the failure
`voteRemainingMs()` in `web/src/screens/NowPlaying.tsx` was written to avoid —
its rule is to return `null` rather than render a dishonest number, and this
follows it.

When the holder starts playing again the number **disappears** and the banner
reverts to its current wording. It never rewinds on screen, and it never
freezes at a low value while a song plays (which would be a lie in the other
direction).

## Beacon cadence — why this needs no extra beacons

`beacon_loop` watches every 1s for a change and otherwise settles to
`active_interval_s = 10s` while something plays and `interval_s = 60s` when
idle.

Grace **expiry is not a state change** — `self._aux_path` does not move — so it
would never earn its own beacon, and on an idle box the next one could be a
full minute away. That is fine under this design and is the reason the deadline
is sent rather than the state:

- The play **closing** already changes `play_part`, which fires an immediate
  beacon. That beacon carries `free_in_ms = 20000`.
- The client ticks that down locally to zero and flips to "free" on its own.

The change signature in `control.py` gains `free_in_ms is None` — the
*indefinite vs. counting* distinction only. Adding the raw milliseconds would
change the signature every second and beacon at 1Hz, which is the opposite of
what this loop is for.

## Staleness

`free_in_ms` is measured on the Pi at its last beacon and is already stale when
it arrives. `auxState()` in the Worker subtracts the age before returning it:

```
free_in_ms - (Date.now() - Date.parse(last_seen_at)), floored at 0
```

This is the correction `played_ms_age_ms` already makes for the progress bar,
applied server-side here because nothing else needs the raw reading.

Worst case is a 60s-idle beacon plus a 7.5s poll, which lands well past a 20s
grace — and floors to 0, correctly reading "the aux is free". The countdown is
only ever *shown* off a beacon fired by the play closing, which is fresh.

## Layers

| Layer | File | Change |
|---|---|---|
| Pi | `pi/lockerroom/lifecycle.py` | `AUX_GRACE = 20s`; `aux_state()` computes `free_in_ms` |
| Pi | `pi/lockerroom/control.py` | change signature gains `free_in_ms is None` |
| DB | `backend/migrations/004-aux-countdown.sql` | `heartbeats.aux_free_in_ms INTEGER`, additive and nullable |
| Worker | `backend/src/index.ts` | `recordAux()` stores it; `auxState()` age-corrects it |
| Web | `web/src/api.ts` | `AuxState.holder.free_in_ms: number \| null` |
| Web | `web/src/screens/NowPlaying.tsx` | `useAuxCountdown` hook; three-state `WaitingBanner` |

Migration `004` is additive and nullable for the reason `003` gives: existing
rows read as NULL, which `/api/now` treats exactly as it treats an older Pi
that does not report the field yet.

## The 20s tradeoff, recorded

Track-to-track transitions are safe at any value — the old play closes and the
new one opens inside one locked handler, so no gap is ever observed.

What 20s changes is the DJ who **stops**, scrolls for something good, and takes
longer than that to find it. They lose the aux mid-scroll. That is accepted:
whoever presses play next gets it, which is the rule the room already runs on,
and a phone left connected in a pocket must not hold the room hostage.

It is one constant. Retune it after a real session.

## Testing

- **Pi:** `free_in_ms` is `None` while a play is open; counts down once it
  closes; is `0` once the grace lapses with the holder still connected. Existing
  tests monkeypatch `AUX_GRACE` rather than hardcoding 45, so the blast radius
  is one docstring.
- **Worker:** age correction floors at 0; a NULL column reads as "no countdown".
- **Web:** the countdown ticks between polls, re-anchors on each poll, and the
  number vanishes rather than rewinding when the holder resumes.

## Deploying

`deploy.sh` over SSH. The CP2102 serial console **cannot** carry this — it is a
login console, not a network link, so there is no `scp` over it. SSH is filtered
between HCGuest clients, so this goes out over home wifi, or over a cell hotspot
with USB-C ethernet and Internet Sharing (`pi@192.168.2.2`).

**Unplug the ethernet cable afterwards.** A dead cable leaves a
`default via ... dev eth0 metric 100` route that beats wlan0 and poisons
`resolv.conf`; see STATE.md.
