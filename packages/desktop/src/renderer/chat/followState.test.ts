import { expect, test, describe } from "bun:test";
import {
  nextFollowState,
  showJumpButton,
  INITIAL_FOLLOW_STATE,
  type FollowState,
} from "./followState";

const following: FollowState = { following: true, atBottom: true };
const paused: FollowState = { following: false, atBottom: false };

describe("nextFollowState — scroll", () => {
  test("user scrolls up past threshold → pause follow", () => {
    const { state, scrollNow } = nextFollowState(following, {
      kind: "scroll",
      distance: 200,
      threshold: 32,
      scrollTop: 100,
      lastProgrammaticTop: null,
    });
    expect(state.following).toBe(false);
    expect(state.atBottom).toBe(false);
    expect(scrollNow).toBe(false);
  });

  test("user scrolls back within threshold → re-arm follow", () => {
    const { state } = nextFollowState(paused, {
      kind: "scroll",
      distance: 10,
      threshold: 32,
      scrollTop: 900,
      lastProgrammaticTop: null,
    });
    expect(state.following).toBe(true);
    expect(state.atBottom).toBe(true);
  });

  test("distance exactly at threshold counts as at-bottom", () => {
    const { state } = nextFollowState(paused, {
      kind: "scroll",
      distance: 32,
      threshold: 32,
      scrollTop: 900,
      lastProgrammaticTop: null,
    });
    expect(state.atBottom).toBe(true);
    expect(state.following).toBe(true);
  });

  test("programmatic snap event does NOT flip following off (S2 race)", () => {
    // We just set scrollTop=1000 programmatically; the async scroll event
    // lands at ~1000. distance may be >threshold transiently mid-layout, but
    // this is OUR scroll, not the user's — following must stay on.
    const { state, scrollNow } = nextFollowState(following, {
      kind: "scroll",
      distance: 50,
      threshold: 32,
      scrollTop: 1000,
      lastProgrammaticTop: 1000,
    });
    expect(state.following).toBe(true);
    expect(scrollNow).toBe(false);
    // atBottom still reflects reality for the UI.
    expect(state.atBottom).toBe(false);
  });

  test("programmatic epsilon: 2px off still treated as programmatic", () => {
    const { state } = nextFollowState(following, {
      kind: "scroll",
      distance: 100,
      threshold: 32,
      scrollTop: 998,
      lastProgrammaticTop: 1000,
    });
    expect(state.following).toBe(true);
  });

  test("beyond epsilon from programmatic target = genuine user scroll", () => {
    const { state } = nextFollowState(following, {
      kind: "scroll",
      distance: 100,
      threshold: 32,
      scrollTop: 900,
      lastProgrammaticTop: 1000,
    });
    expect(state.following).toBe(false);
  });
});

describe("nextFollowState — explicit re-arm signals", () => {
  for (const kind of ["send", "jumpClick", "sessionSwitch"] as const) {
    test(`${kind} re-arms follow + snaps even when paused`, () => {
      const { state, scrollNow } = nextFollowState(paused, { kind });
      expect(state.following).toBe(true);
      expect(state.atBottom).toBe(true);
      expect(scrollNow).toBe(true);
    });
  }
});

describe("showJumpButton", () => {
  test("hidden at bottom", () => {
    expect(showJumpButton(following)).toBe(false);
  });
  test("shown when not at bottom", () => {
    expect(showJumpButton(paused)).toBe(true);
  });
  test("shown when paused but scrolled to a mid position", () => {
    expect(showJumpButton({ following: false, atBottom: false })).toBe(true);
  });
});

describe("initial state", () => {
  test("starts following at bottom", () => {
    expect(INITIAL_FOLLOW_STATE.following).toBe(true);
    expect(INITIAL_FOLLOW_STATE.atBottom).toBe(true);
    expect(showJumpButton(INITIAL_FOLLOW_STATE)).toBe(false);
  });
});
