import { useEffect, useState } from "react";
import { ApiError, get, setUnauthorizedHandler } from "./api";
import type { NowResponse } from "./api";
import { Empty, Nav, Spinner } from "./components";
import { useRoute } from "./router";
import { cacheTheme, cachedTheme } from "./theme";
import type { Theme } from "./theme";
import { Admin } from "./screens/Admin";
import { Claim } from "./screens/Claim";
import { DjBoard } from "./screens/DjBoard";
import { History } from "./screens/History";
import { Join } from "./screens/Join";
import { NowPlaying } from "./screens/NowPlaying";
import { AccountScreen, ProfileScreen, SpeakerScreen } from "./screens/Settings";
import { SongBoard } from "./screens/SongBoard";

const TITLES: Record<string, string> = {
  "/join": "Join",
  "/songs": "Songs",
  "/djs": "DJs",
  "/history": "History",
  "/claim": "Claim your phone",
  "/admin": "Admin",
  "/settings": "Profile",
  "/settings/profile": "Profile",
  "/settings/speaker": "Speaker & connection",
  "/settings/account": "Account",
};

function useDocumentTitle(route: string) {
  useEffect(() => {
    document.title = `${TITLES[route] ?? "Now playing"} \u00b7 AuxGoat`;
  }, [route]);
}

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useState<Theme>(cachedTheme);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  // The team's NAME. Public endpoint, so this works on the join screen too.
  // No colour any more — the palette is fixed; see styles.css.
  useEffect(() => {
    get<Theme>("/api/theme")
      .then((t) => {
        setTheme(t);
        cacheTheme(t);
      })
      .catch(() => {
        /* keep the cached name; an unnamed site still works */
      });
  }, []);

  // One probe to find out whether we have a session. Every screen behind the
  // gate 401s identically, so asking once here beats asking on each.
  //
  // Only a 401 means "signed out". Anything else - no network, a timeout, a
  // 500 - says nothing about the session, so it is retried with backoff
  // rather than guessed: guessing "signed in" stranded a brand-new player on
  // a dead Now Playing, and guessing "signed out" would send a signed-in one
  // back through the team code.
  const [probeFailures, setProbeFailures] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    const probe = () => {
      get<NowResponse>("/api/now")
        .then(() => !cancelled && setSignedIn(true))
        .catch((e) => {
          if (cancelled) return;
          if (e instanceof ApiError && e.status === 401) {
            setSignedIn(false);
            return;
          }
          attempt += 1;
          setProbeFailures(attempt);
          timer = window.setTimeout(probe, Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
        });
    };
    probe();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // A session can also end mid-use: signed out on another tab, deactivated by
  // a coach, or idle past 120 days. Any 401 from any screen lands back on Join.
  useEffect(() => {
    setUnauthorizedHandler(() => setSignedIn(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  useDocumentTitle(signedIn === false && route !== "/admin" ? "/join" : route);

  // Admin is gated by its own password, not by the team session — a coach
  // setting up the roster has no reason to have joined as a player first.
  if (route === "/admin") return <Admin teamName={theme.team_name} />;

  if (signedIn === null) {
    return probeFailures === 0 ? (
      <Spinner />
    ) : (
      <main className="screen">
        <h1 className="sr-only">AuxGoat</h1>
        <Empty title="Can't reach AuxGoat">Check your connection. Retrying&hellip;</Empty>
      </main>
    );
  }
  if (!signedIn) return <Join teamName={theme.team_name} onJoined={() => setSignedIn(true)} />;

  return (
    <div className="app">
      {route === "/songs" ? (
        <SongBoard />
      ) : route === "/djs" ? (
        <DjBoard />
      ) : route === "/history" ? (
        <History />
      ) : route === "/claim" ? (
        <Claim />
      ) : route === "/settings/profile" ? (
        <ProfileScreen />
      ) : route === "/settings/speaker" ? (
        <SpeakerScreen />
      ) : route === "/settings/account" ? (
        <AccountScreen onSignedOut={() => setSignedIn(false)} />
      ) : route === "/settings" ? (
        /* Anything still pointing at the old single page lands on Profile
           rather than a blank screen. */
        <ProfileScreen />
      ) : (
        <NowPlaying teamName={theme.team_name} />
      )}
      <Nav />
    </div>
  );
}
