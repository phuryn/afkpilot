// A cloud machine being BUILT is progress, not a fault. The page used to
// announce it through the error channel, so an ordinary minute of waiting
// arrived in red (owner, 2026-08-31).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chat = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

describe("the cloud first-boot message", () => {
  it("gives a cold build the time the code says it needs before calling it broken", () => {
    // The relay itself documents a from-scratch install at up to 25 minutes.
    // Declaring failure 90s in told people to reset a machine that was fine
    // (review, 2026-08-31).
    expect(chat).toContain("var CLOUD_FIRST_BOOT_NOTE_MS = 90000;");
    expect(chat).toContain("var CLOUD_FIRST_BOOT_ERROR_MS = 25 * 60 * 1000;");
    // The 90s mark explains; only the long window blames.
    const noteBlock = chat.slice(chat.indexOf("firstBootNoteTimer = setTimeout"));
    expect(noteBlock.slice(0, 500)).toContain('type: "hostNotice"');
    expect(noteBlock.slice(0, 500)).toContain("up to 25 minutes");
  });

  it("remembers per DEVICE that a host was seen, so a reload is not a first boot", () => {
    // everSawHost was page-local: reopening a page for a machine that had
    // worked for days classified it as still building.
    expect(chat).toContain('var everSawHostKey = "afk.sawHost." + (device || "unknown");');
    expect(chat).toMatch(/localStorage\.getItem\(everSawHostKey\)/);
    expect(chat).toMatch(/localStorage\.setItem\(everSawHostKey, "1"\)/);
  });

  it("says nothing when a cloud machine sleeps MID-CONVERSATION", () => {
    // Sleeping is the resting state this product sells — it wakes on the next
    // send. Announcing it as a fault told the owner something was wrong while
    // he was reading, gave him nothing to do, and was contradicted a minute
    // later by the machine answering (2026-08-31).
    expect(chat).toContain("var cloudAsleep = isCloudDevice && everSawHost;");
    expect(chat).toContain("if (cloudAsleep && sawHostThisLoad && !held) return;");
    // The old red sentence is gone.
    expect(chat).not.toContain("Your cloud environment isn't responding.");
  });

  it("but DOES say the machine is waking when the page has nothing yet", () => {
    // The silence above was keyed on a flag remembered in localStorage per
    // device, so it also covered arriving at a sleeping machine with an empty
    // rail and nothing to send. Attaching wakes it and resuming takes the best
    // part of a minute; with nothing said, that is indistinguishable from a
    // broken page, and the owner reloaded repeatedly into it (2026-09-01).
    //
    // The distinction is per PAGE LOAD, not per device: a reload starts empty
    // however old the machine is.
    expect(chat).toContain("var sawHostThisLoad = false;");
    expect(chat).toContain("sawHostThisLoad = true;");
    expect(chat).toContain("var wakingOnArrival = cloudAsleep && !sawHostThisLoad;");
    expect(chat).toContain("Waking your cloud machine.");
    // Calm channel: nothing has failed, the machine is coming up.
    const at = chat.indexOf("var wakingOnArrival");
    expect(chat.slice(at, at + 2600)).toContain('type: stillBooting || cloudAsleep ? "hostNotice" : "error"');
  });

  it("still says where a held message went, and says it calmly", () => {
    // With something queued the person needs to know it is safe. Nothing has
    // failed, so it goes through the notice channel, not the error one.
    const at = chat.indexOf("var cloudAsleep = isCloudDevice && everSawHost;");
    expect(at).toBeGreaterThan(-1);
    const block = chat.slice(at, at + 1200);
    expect(block).toContain("Your cloud machine is asleep.");
    expect(chat).toContain('type: stillBooting || cloudAsleep ? "hostNotice" : "error"');
  });

  it("uses the notice channel while booting and the error channel for real failures", () => {
    expect(chat).toContain('type: stillBooting || cloudAsleep ? "hostNotice" : "error"');
    // The escalation after a boot that never finishes stays an error.
    expect(chat).toMatch(/still hasn't come up[\s\S]{0,200}?/);
    const escalation = chat.slice(chat.indexOf("firstBootErrorTimer = setTimeout"));
    expect(escalation.slice(0, 400)).toContain('type: "error"');
  });

  it("renders as progress: a spinner in the notice's own blue, and reduced-motion honoured", () => {
    expect(chat).toContain("markBootingNotice");
    expect(chat).toContain(".plan-notice.cloud-booting");
    expect(chat).toContain("cloud-booting-spin");
    expect(chat).toMatch(/prefers-reduced-motion[\s\S]{0,220}cloud-booting/);
  });
});
