// Stands in for the SDK's adb (argv[2] "adb") and emulator (argv[2] "emulator") over a state file in argv[3], the
// fake SDK dir. Every call is appended to calls.log; `am start` appends the lines in app.log to logcat.txt. The AVD
// "Crash" exits while booting; "Fresh" drops adb's connection once, as a fresh AVD's first boot does.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

interface State {
  running: Record<string, { pid?: number; avd?: string }>;
  installed: string[];
  reverse: string[];
}

const [role = "", sdk = "", ...args] = process.argv.slice(2);
const file = (name: string) => join(sdk, name);
const read = (): State => JSON.parse(readFileSync(file("state.json"), "utf8")) as State;
/** Replaces `name` in one step, so a reader never sees it half-written. */
const publish = (name: string, text: string) => {
  writeFileSync(file(`${name}.tmp`), text);
  renameSync(file(`${name}.tmp`), file(name));
};
const write = (state: State) => publish("state.json", JSON.stringify(state));
appendFileSync(file("calls.log"), `${JSON.stringify([role, ...args])}\n`);

/** Runs `check` now and every 20 ms until it returns true; polling has no gap for a change to slip through. */
function whenever(check: () => boolean) {
  if (check()) return;
  const timer = setInterval(() => {
    if (check()) clearInterval(timer);
  }, 20);
}

if (role === "emulator") {
  if (args[0] === "-list-avds") {
    process.stdout.write(`INFO    | a notice on stdout\n${readFileSync(file("avds.txt"), "utf8")}`);
  } else {
    const avd = args[args.indexOf("-avd") + 1] ?? "";
    const port = Number(args[args.indexOf("-port") + 1]);
    if (avd === "Crash") {
      // Exits before registering, as an emulator without hardware acceleration does, once adb is waiting for it.
      whenever(() => {
        if (!existsSync(file("wait.pid"))) return false;
        process.stdout.write("x86_64 emulation currently requires hardware acceleration\n");
        process.exit(1);
      });
    } else {
      // Holds the console port open, as a real emulator does, until `adb emu kill` ends it.
      createServer().listen(port, "127.0.0.1", () => {
        const state = read();
        state.running[`emulator-${port}`] = { pid: process.pid, avd };
        write(state);
      });
      process.once("SIGTERM", () => process.exit(0));
    }
  }
} else if (args[0] === "devices") {
  const lines = Object.keys(read().running).map((s) => `${s}\tdevice\n`);
  process.stdout.write(`List of devices attached\n${lines.join("")}\n`);
} else {
  const [, serial = "", command, ...rest] = args;
  const sub = rest.join(" ");
  const state = read();
  if (command === "wait-for-device") {
    // Its own file: a write to state.json here could overwrite the booting emulator's registration.
    publish("wait.pid", String(process.pid));
    whenever(() => {
      const booting = read().running[serial];
      if (booting === undefined) return false;
      if (booting.avd === "Fresh" && !existsSync(file("dropped"))) {
        writeFileSync(file("dropped"), "");
        process.exit(255);
      }
      return true;
    });
  } else if (!(serial in state.running)) {
    process.stderr.write(`adb: device '${serial}' not found\n`);
    process.exitCode = 1;
  } else if (command === "logcat") {
    let sent = 0;
    whenever(() => {
      const text = existsSync(file("logcat.txt")) ? readFileSync(file("logcat.txt"), "utf8") : "";
      process.stdout.write(text.slice(sent));
      sent = text.length;
      return false;
    });
  } else if (command === "emu" && sub === "kill") {
    const { pid } = state.running[serial] ?? {};
    delete state.running[serial];
    write(state);
    if (pid !== undefined) process.kill(pid, "SIGTERM");
  } else if (command === "reverse") {
    state.reverse =
      rest[0] === "--remove"
        ? state.reverse.filter((r) => r !== rest[1])
        : [...state.reverse, rest[0] ?? ""];
    write(state);
  } else if (command === "install") {
    state.installed.push(readFileSync(rest[0] ?? "", "utf8").trim());
    write(state);
  } else if (command === "uninstall") {
    state.installed = state.installed.filter((p) => p !== rest[0]);
    write(state);
  } else if (sub === "getprop ro.product.cpu.abi") {
    process.stdout.write("x86_64\n");
  } else if (sub === "date +%s") {
    process.stdout.write(`${Math.floor(Date.now() / 1000)}\n`);
  } else if (sub.startsWith("pm list packages ")) {
    const wanted = rest.at(-1) ?? "";
    process.stdout.write(
      state.installed
        .filter((p) => p.startsWith(wanted))
        .map((p) => `package:${p}\n`)
        .join(""),
    );
  } else if (sub.startsWith("am start -W -n ")) {
    const pkg = (rest.at(-1) ?? "").split("/")[0] ?? "";
    if (!state.installed.includes(pkg)) {
      process.stdout.write(`Error: Activity class {${rest.at(-1)}} does not exist.\n`);
    } else {
      process.stdout.write("Status: ok\n");
      appendFileSync(file("logcat.txt"), readFileSync(file("app.log"), "utf8"));
    }
  } else if (!sub.startsWith("am force-stop ")) {
    process.stderr.write(`fake adb: unknown command ${args.join(" ")}\n`);
    process.exitCode = 1;
  }
}
