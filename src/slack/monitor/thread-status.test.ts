import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireThreadStatus,
  isThreadActive,
  getCurrentStatus,
  pushCurrentStatus,
  _resetAllManagers,
} from "./thread-status.js";

describe("ThreadStatusManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetAllManagers();
  });

  it("single handle lifecycle: thinking with 1s counter", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });

    handle.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("thinking 0s");

    // 1s tick.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(push).toHaveBeenCalledWith("thinking 1s");

    // Another tick.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(push).toHaveBeenCalledWith("thinking 2s");

    // Release → grace → destroy.
    handle.release();
    push.mockClear();
    await vi.advanceTimersByTimeAsync(5_100);

    // After grace — no more pushes.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("counter resets on phase change", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });

    handle.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("thinking 0s");

    // Advance 3 seconds.
    await vi.advanceTimersByTimeAsync(3_000);

    // Phase change → counter resets.
    push.mockClear();
    handle.setStatus("reasoning");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("reasoning 0s");

    push.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(push).toHaveBeenCalledWith("reasoning 1s");

    handle.release();
    await vi.advanceTimersByTimeAsync(5_100);
  });

  it("reading status: no counter timer", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });

    handle.setStatus("reading");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("reading messages...");

    // No counter ticks.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(push).not.toHaveBeenCalled();

    handle.release();
    await vi.advanceTimersByTimeAsync(5_100);
  });

  it("multiple handles — blink-free: h1 release → h2 acquire within grace → no gap", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const h1 = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });

    h1.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("thinking 0s");

    h1.release();
    await vi.advanceTimersByTimeAsync(100);

    // Acquire h2 within grace period.
    push.mockClear();
    const h2 = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });
    h2.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("thinking 0s");

    // Counter works on h2.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(push).toHaveBeenCalledWith("thinking 1s");

    h2.release();
    await vi.advanceTimersByTimeAsync(5_100);

    push.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("lazy start: acquire → release without setStatus → no push", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });

    handle.release();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(push).not.toHaveBeenCalled();
  });

  it("idempotent release: double release → no error", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });

    handle.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);

    handle.release();
    handle.release();
    await vi.advanceTimersByTimeAsync(5_100);

    push.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("in-flight guard: slow push → tick skipped", async () => {
    vi.useFakeTimers();
    let resolveSlowPush: () => void;
    const slowPush = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSlowPush = resolve;
        }),
    );

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push: slowPush,
      graceMs: 5_000,
    });

    handle.setStatus("thinking");
    // First push starts but doesn't resolve.
    await vi.advanceTimersByTimeAsync(0);
    expect(slowPush).toHaveBeenCalledTimes(1);

    // 1s tick — push still in-flight, tick should be skipped.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slowPush).toHaveBeenCalledTimes(1);

    // Resolve the first push.
    resolveSlowPush!();
    await vi.advanceTimersByTimeAsync(0);

    // Next tick — push is free, should fire.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slowPush).toHaveBeenCalledTimes(2);

    handle.release();
    await vi.advanceTimersByTimeAsync(5_100);
  });

  it("self-cleanup: after destroy, new acquire creates a fresh manager", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const h1 = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 100,
    });

    h1.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);
    h1.release();

    // Wait for grace + destroy.
    await vi.advanceTimersByTimeAsync(200);
    push.mockClear();

    // New acquire should work with a fresh manager.
    const h2 = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 100,
    });

    h2.setStatus("reasoning");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("reasoning 0s");

    h2.release();
    await vi.advanceTimersByTimeAsync(200);
  });

  it("setStatus after release is a no-op", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 100,
    });

    handle.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);
    handle.release();

    push.mockClear();
    handle.setStatus("reasoning");
    await vi.advanceTimersByTimeAsync(1_000);

    // Should NOT have pushed "reasoning 0s".
    expect(push).not.toHaveBeenCalledWith("reasoning 0s");

    await vi.advanceTimersByTimeAsync(200);
  });

  it("shouldGrace false: stops immediately", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
      shouldGrace: () => false,
    });

    handle.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("thinking 0s");

    push.mockClear();
    handle.release();

    // No counter ticks — stopped immediately.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("shouldGrace true: uses normal grace period", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
      shouldGrace: () => true,
    });

    handle.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);

    handle.release();
    // During grace, counter still ticks.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(push).toHaveBeenCalled();

    // After grace → stop.
    await vi.advanceTimersByTimeAsync(5_000);
    push.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("shouldGrace dynamic: grace when pending, no grace when empty", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);
    let hasPending = true;

    const h1 = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
      shouldGrace: () => hasPending,
    });

    h1.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);

    h1.release();
    await vi.advanceTimersByTimeAsync(100);

    // h2 acquires within grace.
    const h2 = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
      shouldGrace: () => hasPending,
    });
    h2.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);

    hasPending = false;
    push.mockClear();
    h2.release();

    // shouldGrace returns false → immediate stop.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("push errors are forwarded to onError", async () => {
    vi.useFakeTimers();
    const pushError = new Error("API failure");
    const push = vi.fn().mockRejectedValue(pushError);
    const onError = vi.fn();

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 100,
      onError,
    });

    handle.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(pushError);

    handle.release();
    await vi.advanceTimersByTimeAsync(200);
  });

  it("pause: stops counter, setStatus restarts it", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });

    handle.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("thinking 0s");

    // pause stops the counter.
    push.mockClear();
    handle.pause();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(push).not.toHaveBeenCalled();

    // setStatus restarts.
    handle.setStatus("reasoning");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("reasoning 0s");

    // Counter is running.
    push.mockClear();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(push).toHaveBeenCalledWith("reasoning 1s");

    handle.release();
    await vi.advanceTimersByTimeAsync(5_100);
  });

  it("isThreadActive: true when handles > 0", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    expect(isThreadActive("C1:T1")).toBe(false);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 100,
    });

    expect(isThreadActive("C1:T1")).toBe(true);

    handle.release();
    await vi.advanceTimersByTimeAsync(200);

    expect(isThreadActive("C1:T1")).toBe(false);
  });

  it("getCurrentStatus: returns formatted text", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    expect(getCurrentStatus("C1:T1")).toBeNull();

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });

    // Before setStatus — null.
    expect(getCurrentStatus("C1:T1")).toBeNull();

    handle.setStatus("thinking");
    expect(getCurrentStatus("C1:T1")).toBe("thinking 0s");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(getCurrentStatus("C1:T1")).toBe("thinking 2s");

    handle.setStatus("reasoning");
    expect(getCurrentStatus("C1:T1")).toBe("reasoning 0s");

    handle.setStatus("reading");
    expect(getCurrentStatus("C1:T1")).toBe("reading messages...");

    handle.release();
    await vi.advanceTimersByTimeAsync(5_100);
  });

  it("pushCurrentStatus: re-pushes current text (instant restoration)", async () => {
    vi.useFakeTimers();
    const push = vi.fn().mockResolvedValue(undefined);

    const handle = acquireThreadStatus({
      key: "C1:T1",
      push,
      graceMs: 5_000,
    });

    handle.setStatus("thinking");
    await vi.advanceTimersByTimeAsync(2_000);

    push.mockClear();
    pushCurrentStatus("C1:T1");
    await vi.advanceTimersByTimeAsync(0);
    expect(push).toHaveBeenCalledWith("thinking 2s");

    handle.release();
    await vi.advanceTimersByTimeAsync(5_100);
  });

  it("pushCurrentStatus on unknown key: no-op", () => {
    // Should not throw.
    pushCurrentStatus("UNKNOWN:KEY");
  });
});
