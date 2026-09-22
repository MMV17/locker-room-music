import { useEffect, useState } from "react";
import { ApiError, get } from "./api";
import type { NowResponse } from "./api";
import { Nav, Spinner } from "./components";
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
  useEffect(() => {
    get<NowResponse>("/api/now")
      .then(() => setSignedIn(true))
      .catch((e) => setSignedIn(!(e instanceof ApiError && e.status === 401)));
  }, []);

  // Admin is gated by its own password, not by the team session — a coach
  // setting up the roster has no reason to have joined as a player first.
  if (route === "/admin") return <Admin teamName={theme.team_name} />;

  if (signedIn === null) return <Spinner />;
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
