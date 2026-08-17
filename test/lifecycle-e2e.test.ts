import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyQueueRelease,
  describeIsolationMismatch,
  errorMarksInterruptedSend,
  hostProcessGone,
  hostRequired,
  INTERRUPTED_SEND_CODE,
  isFollowUpNewSessionFrame,
  isInterruptedSendPhrase,
  isReplacementHostFrameType,
  unselectedRepoPlusSettled,
  parseInvert,
  persistTurnForLoad,
  queuedSendInterruptedAfterEcho,
  queuedTurnArrived,
  resolveExtensionRoot,
  sessionStoreDir,
  skipReason,
  waitFor,
} from "../scripts/lifecycle-e2e.mjs";

const INTERRUPT_PHRASE =
  "The session restarted while this message was being sent, so delivery is uncertain. Check the conversation and send it again if needed.";

describe("lifecycle e2e harness", () => {
  it("skips only when the sibling checkout or part-1 runner is absent", () => {
    expect(skipReason("")).toMatch(/not found/i);
    expect(skipReason(join(tmpdir(), "no-such-grok-build-vscode"))).toMatch(/not found/i);

    const root = mkdtempSync(join(tmpdir(), "afk-lifecycle-skip-"));
    try {
      expect(skipReason(root)).toMatch(/lifecycle host runner missing/i);
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts", "lifecycle-host.mjs"), "// stub\n");
      expect(skipReason(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the sibling next to this repo unless GROK_BUILD_VSCODE is set", () => {
    const fromEnv = resolveExtensionRoot({ GROK_BUILD_VSCODE: "D:\\other\\ext" }, "C:\\relay");
    expect(fromEnv.replace(/\\/g, "/")).toMatch(/other\/ext$/);
    // Built with join, never a backslash literal. resolve() has no idea that a
    // backslash separates anything on POSIX, so "C:\\work\\grok-remote" arrives
    // as ONE relative segment there and the sibling resolves against cwd —
    // /home/runner/work/afkpilot/afkpilot/grok-build-vscode on the runner. The
    // assertion could never pass on Linux and only looked green because it was
    // written on Windows.
    const sibling = resolveExtensionRoot({}, join("C:", "work", "grok-remote"));
    expect(sibling.replace(/\\/g, "/")).toMatch(/work\/grok-build-vscode$/);
  });

  it("names what never arrived", async () => {
    await expect(waitFor(() => false, "the host to detach", 80)).rejects.toThrow(
      /timed out waiting for the host to detach/,
    );
  });

  it("parses invert faults as a set", () => {
    expect([...parseInvert("skip-kill, skip-admission")].sort()).toEqual([
      "skip-admission",
      "skip-kill",
    ]);
    expect(parseInvert("").size).toBe(0);
  });

  it("seeds session/load replay files under GROK_HOME, never ~/.grok", () => {
    const home = mkdtempSync(join(tmpdir(), "afk-lifecycle-home-"));
    try {
      persistTurnForLoad(home, home, "sess-1", "hello", "ok");
      const dir = sessionStoreDir(home, home, "sess-1");
      expect(dir.startsWith(home)).toBe(true);
      expect(dir.includes(".grok")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the script itself skips loudly and exits 0 when the sibling is absent", () => {
    const missing = join(tmpdir(), "afk-no-sibling-lifecycle");
    const run = spawnSync(process.execPath, ["scripts/lifecycle-e2e.mjs"], {
      encoding: "utf8",
      env: { ...process.env, GROK_BUILD_VSCODE: missing, LIFECYCLE_REQUIRE_HOST: "" },
    });
    expect(run.status).toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/SKIP:/);
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/not found/);
  });

  it("fails instead of skipping when LIFECYCLE_REQUIRE_HOST is set", () => {
    expect(hostRequired({ LIFECYCLE_REQUIRE_HOST: "1" })).toBe(true);
    expect(hostRequired({ LIFECYCLE_REQUIRE_HOST: "true" })).toBe(true);
    expect(hostRequired({})).toBe(false);

    const missing = join(tmpdir(), "afk-no-sibling-lifecycle-required");
    const run = spawnSync(process.execPath, ["scripts/lifecycle-e2e.mjs"], {
      encoding: "utf8",
      env: { ...process.env, GROK_BUILD_VSCODE: missing, LIFECYCLE_REQUIRE_HOST: "1" },
    });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/LIFECYCLE_REQUIRE_HOST/);
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/not found/);
  });

  it("treats a POSIX signal death as the process being gone", () => {
    expect(hostProcessGone({ exitCode: null, signal: "SIGKILL", child: { killed: false } })).toBe(true);
    expect(hostProcessGone({ exitCode: 0, signal: null, child: { killed: false } })).toBe(true);
    expect(hostProcessGone({ exitCode: null, signal: null, child: { killed: true } })).toBe(true);
    expect(hostProcessGone({ exitCode: null, signal: null, child: { killed: false } })).toBe(false);
  });

  it("does not treat a stale agent ok as delivery of a later prompt", () => {
    const stale = { users: ["lifecycle-queued-while-down"], agents: ["ok"] };
    expect(queuedTurnArrived(stale, "lifecycle-queued-while-down", 1)).toBe(false);
    expect(queuedTurnArrived(
      { users: ["lifecycle-queued-while-down"], agents: ["ok", "ok"] },
      "lifecycle-queued-while-down",
      1,
    )).toBe(true);
    expect(queuedTurnArrived(
      { users: ["lifecycle-alpha-one"], agents: ["ok"] },
      "lifecycle-queued-while-down",
      0,
    )).toBe(false);
  });

  it("arrival inspects only the newly added agent bubbles", () => {
    const prompt = "lifecycle-queued-while-down";
    expect(queuedTurnArrived(
      { users: [prompt], agents: ["ok", "partial"] },
      prompt,
      1,
    )).toBe(false);
    expect(queuedTurnArrived(
      { users: [prompt], agents: ["partial"] },
      prompt,
      0,
    )).toBe(false);
    expect(queuedTurnArrived(
      { users: [prompt], agents: ["ok"] },
      prompt,
      0,
    )).toBe(true);
    expect(classifyQueueRelease(
      { users: [prompt], agents: ["ok", "partial"] },
      prompt,
      1,
    )).toBe(null);
  });

  it("names queue-release outcomes instead of matching host copy", () => {
    const prompt = "lifecycle-queued-while-down";
    expect(classifyQueueRelease(
      { users: [prompt], agents: ["ok", "ok"] },
      prompt,
      1,
    )).toBe("arrived");
    expect(classifyQueueRelease(
      { users: [prompt], agents: ["ok"] },
      prompt,
      1,
      [
        { type: "userMessage", text: prompt },
        { type: "error", code: INTERRUPTED_SEND_CODE, text: INTERRUPT_PHRASE },
      ],
    )).toBe("interrupted-after-echo");
    expect(classifyQueueRelease(
      { users: [prompt], agents: ["ok"] },
      prompt,
      1,
      [
        { type: "userMessage", text: prompt },
        { type: "error", text: INTERRUPT_PHRASE },
      ],
    )).toBe("interrupted-after-echo");
    expect(classifyQueueRelease(
      { users: [prompt], agents: ["ok"], errors: ["Still restoring the previous conversation."] },
      prompt,
      1,
      [{ type: "error", text: "Still restoring the previous conversation." }, { type: "userMessage", text: prompt }],
    )).toBe(null);
    expect(classifyQueueRelease(
      { users: [prompt], agents: ["ok"], input: "" },
      prompt,
      1,
      [{ type: "userMessage", text: prompt }],
    )).toBe(null);
    expect(classifyQueueRelease(
      { users: [], agents: ["ok"], input: prompt },
      prompt,
      0,
    )).toBe("failed-visibly-recoverable");
    expect(classifyQueueRelease(
      { users: [], agents: [], queued: [prompt] },
      prompt,
      0,
    )).toBe("failed-visibly-recoverable");
    expect(isFollowUpNewSessionFrame("clearMessages")).toBe(true);
    expect(isFollowUpNewSessionFrame("error")).toBe(false);
  });

  it("interrupted-after-echo stays red without a correlated post-echo interrupt", () => {
    const prompt = "lifecycle-queued-while-down";
    const echoed = { users: [prompt], agents: ["ok"] };

    expect(classifyQueueRelease(
      echoed,
      prompt,
      1,
      [{ type: "userMessage", text: prompt }, { type: "error", text: "CLI failed to start" }],
    )).toBe(null);
    expect(queuedSendInterruptedAfterEcho(
      [{ type: "userMessage", text: prompt }, { type: "error", text: "CLI failed to start" }],
      prompt,
    )).toBe(false);

    expect(classifyQueueRelease(
      { ...echoed, errorCodes: [INTERRUPTED_SEND_CODE] },
      prompt,
      1,
      [],
    )).toBe(null);
    expect(classifyQueueRelease(
      { ...echoed, errorCodes: [INTERRUPTED_SEND_CODE] },
      prompt,
      1,
      [{ type: "error", code: INTERRUPTED_SEND_CODE }, { type: "userMessage", text: prompt }],
    )).toBe(null);

    expect(classifyQueueRelease(
      echoed,
      prompt,
      1,
      [{ type: "userMessage" }, { type: "error", text: INTERRUPT_PHRASE }],
    )).toBe(null);
    expect(classifyQueueRelease(
      { ...echoed, errors: [INTERRUPT_PHRASE] },
      prompt,
      1,
      [],
    )).toBe(null);

    expect(classifyQueueRelease(
      echoed,
      prompt,
      1,
      [
        { type: "userMessage", text: "lifecycle-alpha-two" },
        { type: "error", code: INTERRUPTED_SEND_CODE, text: INTERRUPT_PHRASE },
      ],
    )).toBe(null);

    expect(classifyQueueRelease(
      echoed,
      prompt,
      1,
      [
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
        { type: "error", code: INTERRUPTED_SEND_CODE, submissionId: "sub-other" },
      ],
    )).toBe(null);

    expect(queuedSendInterruptedAfterEcho(
      [
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
        { type: "error", code: INTERRUPTED_SEND_CODE, submissionId: "sub-queued" },
      ],
      prompt,
    )).toBe(true);

    expect(queuedSendInterruptedAfterEcho(
      [
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
        { type: "error", code: INTERRUPTED_SEND_CODE, submissionId: "sub-queued" },
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
      ],
      prompt,
    )).toBe(false);
    expect(classifyQueueRelease(
      echoed,
      prompt,
      1,
      [
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
        { type: "error", code: INTERRUPTED_SEND_CODE, submissionId: "sub-queued" },
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
      ],
    )).toBe(null);
    expect(queuedSendInterruptedAfterEcho(
      [
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
        { type: "error", code: INTERRUPTED_SEND_CODE, submissionId: "sub-queued" },
        { type: "initialState" },
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
      ],
      prompt,
    )).toBe(true);
    expect(classifyQueueRelease(
      echoed,
      prompt,
      1,
      [
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
        { type: "error", code: INTERRUPTED_SEND_CODE, submissionId: "sub-queued" },
        { type: "initialState" },
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
      ],
    )).toBe("interrupted-after-echo");
    expect(queuedSendInterruptedAfterEcho(
      [
        { type: "userMessage", text: prompt },
        { type: "error", code: INTERRUPTED_SEND_CODE },
        { type: "userMessage", text: prompt },
      ],
      prompt,
    )).toBe(false);
    expect(queuedSendInterruptedAfterEcho(
      [
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
        { type: "userMessage", text: "lifecycle-alpha-two" },
        { type: "error", code: INTERRUPTED_SEND_CODE, submissionId: "sub-queued" },
      ],
      prompt,
    )).toBe(false);
    expect(queuedSendInterruptedAfterEcho(
      [
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
        { type: "error", code: INTERRUPTED_SEND_CODE, submissionId: "sub-queued" },
        { type: "userMessage", text: "lifecycle-alpha-two", submissionId: "sub-other" },
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
      ],
      prompt,
    )).toBe(false);
    expect(classifyQueueRelease(
      echoed,
      prompt,
      1,
      [
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
        { type: "error", code: INTERRUPTED_SEND_CODE, submissionId: "sub-queued" },
        { type: "userMessage", text: "lifecycle-alpha-two", submissionId: "sub-other" },
        { type: "userMessage", text: prompt, submissionId: "sub-queued" },
      ],
    )).toBe(null);
    expect(errorMarksInterruptedSend({ type: "error", code: INTERRUPTED_SEND_CODE, text: "anything" })).toBe(true);
    expect(errorMarksInterruptedSend({ type: "error", text: INTERRUPT_PHRASE })).toBe(true);
    expect(errorMarksInterruptedSend({ type: "error", text: "CLI failed to start" })).toBe(false);
    expect(isInterruptedSendPhrase(INTERRUPT_PHRASE)).toBe(true);
    expect(isInterruptedSendPhrase("Still restoring the previous conversation.")).toBe(false);
  });

  it("treats a queued turn that landed during restore as arrival, not a silent drop", () => {
    const prompt = "lifecycle-queued-while-down";
    const afterFlush = {
      users: ["lifecycle-alpha-two", `${prompt}\n9:07 PM`],
      agents: ["ok\n9:07 PM", "ok\n9:07 PM"],
    };
    expect(queuedTurnArrived(afterFlush, prompt, 2)).toBe(false);
    expect(queuedTurnArrived(afterFlush, prompt, 1)).toBe(true);
    expect(classifyQueueRelease(afterFlush, prompt, 1)).toBe("arrived");
  });

  it("does not wait for tab identity on an empty new session after repo +", () => {
    const ready = {
      previousPrompts: ["lifecycle-alpha-two"],
      users: [],
      restoring: false,
      welcome: "Connected",
      sendTitle: "Send",
      railNewIntent: null,
    };
    expect(unselectedRepoPlusSettled({ ...ready, sessionFramesSinceClick: 1 })).toBe(false);
    expect(unselectedRepoPlusSettled({ ...ready, sessionFramesSinceClick: 2 })).toBe(true);
    expect(unselectedRepoPlusSettled({
      ...ready,
      railNewIntent: "C:\\tmp\\bravo",
      sessionFramesSinceClick: 2,
    })).toBe(false);
    expect(unselectedRepoPlusSettled({
      ...ready,
      users: ["lifecycle-alpha-two"],
      sessionFramesSinceClick: 2,
    })).toBe(false);
  });

  it("isolation mismatch reports observed ids, not a stale constant-id hypothesis", () => {
    const msg = describeIsolationMismatch({
      expectedRepo: "bravo",
      remembered: { id: "fake-session-54380-1" },
      previousId: "fake-session-54380-1",
      users: ["lifecycle-alpha-one"],
      title: "lifecycle-alpha-one",
    });
    expect(msg).toMatch(/fake-session-54380-1/);
    expect(msg).toMatch(/lifecycle-alpha-one/);
    expect(msg).not.toMatch(/If both workspaces share fake-session-1/);
    expect(msg).not.toMatch(/fixture is still minting a constant id/);
    expect(isReplacementHostFrameType("initialState")).toBe(true);
    expect(isReplacementHostFrameType("error")).toBe(false);
  });

  it("always compiles the sibling instead of trusting an existing out/", () => {
    const src = readFileSync(join("scripts", "lifecycle-e2e.mjs"), "utf8");
    expect(src).not.toMatch(/if \(existsSync\(frames\) && existsSync\(desktop\)\) return/);
    expect(src).toMatch(/do not trust a stale out/);
    expect(src).toMatch(/stdio: \["pipe", "pipe", "pipe"\]/);
    expect(src).toMatch(/GROK_LIFECYCLE_HOST_SHUTDOWN/);
    expect(src).not.toMatch(/offline\|not sent\|returned to the input/);
    expect(src).toMatch(/INTERRUPTED_SEND_CODE/);
    expect(src).toMatch(/queuedSendInterruptedAfterEcho/);
    expect(src).not.toMatch(/coded \|\| errorAfterUserEcho/);
    expect(src).not.toMatch(/agents\.some\(\(a\) => String\(a\)\.includes\(AGENT_OK\)\)/);
  });
});
