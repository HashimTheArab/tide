// Stands in for `xcrun simctl` over a state file in argv[2], the fake's dir. Every call is appended to calls.log;
// `launch` appends what the app logs to log.txt, which `spawn <udid> log stream` follows after printing a header.
// A log stream that SIGTERM ends writes stream.ended; the simulator named "NoLog" cannot stream, "NoBoot" cannot
// boot, and the bundle ID "NoUninstall" cannot be uninstalled. A FIFO named hold-<command> holds that command, with its PID in <command>.pid, before it reads or changes
// state, until the test closes the FIFO.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { installApp, launchApp } from "./fake-app.ts";

interface Simulator {
  udid: string;
  name: string;
  state: string;
  runtime: string;
  isAvailable: boolean;
}

interface State {
  simulators: Simulator[];
  installed: Record<string, string[]>; // By UDID.
  running: string[]; // `<udid> <bundle ID>`
}

const [dir = "", tool = "", ...args] = process.argv.slice(2);
const file = (name: string) => join(dir, name);
const read = (): State => JSON.parse(readFileSync(file("state.json"), "utf8")) as State;
const write = (state: State) => {
  writeFileSync(file("state.json.tmp"), JSON.stringify(state));
  renameSync(file("state.json.tmp"), file("state.json"));
};
appendFileSync(file("calls.log"), `${JSON.stringify([tool, ...args])}\n`);

const fail = (message: string, code = 1) => {
  process.stderr.write(`An error was encountered processing the command:\n${message}\n`);
  process.exitCode = code;
};

const [command, udid = "", ...rest] = args;
const hold = file(`hold-${command}`);
if (existsSync(hold)) {
  writeFileSync(file(`${command}.pid`), String(process.pid));
  readFileSync(hold);
  rmSync(hold);
}
const state = read();
const sim = state.simulators.find((s) => s.udid === udid);
const installed = (state.installed[udid] ??= []);

if (tool !== "simctl") {
  fail(`fake xcrun: unknown tool ${tool}`);
} else if (command === "list" && udid === "devices" && rest[0] === "--json") {
  const devices: Record<string, Omit<Simulator, "runtime">[]> = {};
  for (const { runtime, ...device } of state.simulators) (devices[runtime] ??= []).push(device);
  process.stdout.write(JSON.stringify({ devices }));
} else if (sim === undefined) {
  fail(`Invalid device: ${udid}`, 164);
} else if (command === "boot") {
  if (sim.state !== "Shutdown" || sim.name === "NoBoot") {
    fail(
      `Unable to boot device in current state: ${sim.name === "NoBoot" ? "Booted" : sim.state}`,
      149,
    );
  } else {
    sim.state = "Booted";
    write(state);
  }
} else if (command === "bootstatus") {
  if (sim.state !== "Booted") fail("not booting");
} else if (command === "shutdown") {
  if (sim.state === "Shutdown") {
    fail("Unable to shutdown device in current state: Shutdown", 149);
  } else {
    sim.state = "Shutdown";
    write(state);
  }
} else if (sim.state !== "Booted") {
  fail(`Unable to ${command} in current state: ${sim.state}`, 149);
} else if (command === "install") {
  installed.push(installApp(dir, rest[0] ?? ""));
  write(state);
} else if (command === "uninstall" && rest[0] === "NoUninstall") {
  fail("Failed to uninstall the requested application", 2);
} else if (command === "uninstall") {
  state.installed[udid] = installed.filter((id) => id !== rest[0]);
  write(state);
} else if (command === "launch") {
  const id = rest[0] ?? "";
  if (!installed.includes(id)) {
    fail(`The request to open "${id}" failed.`, 4);
  } else {
    state.running.push(`${udid} ${id}`);
    write(state);
    process.stdout.write(`${id}: ${process.pid}\n`);
    await launchApp(dir, id, file("log.txt"));
  }
} else if (command === "terminate") {
  const key = `${udid} ${rest[0]}`;
  if (!state.running.includes(key)) {
    fail(`Simulator device failed to terminate ${rest[0]}.\nfound nothing to terminate`, 3);
  } else {
    state.running = state.running.filter((r) => r !== key);
    write(state);
  }
} else if (command === "spawn" && rest.join(" ").startsWith("log stream ")) {
  if (sim.name === "NoLog") {
    fail("log: Could not open the log stream");
  } else {
    writeFileSync(file("stream.pid"), String(process.pid));
    process.stdout.write(`Filtering the log data using "${rest.at(-1)}"\n`);
    let sent = 0;
    const timer = setInterval(() => {
      const text = existsSync(file("log.txt")) ? readFileSync(file("log.txt"), "utf8") : "";
      process.stdout.write(text.slice(sent));
      sent = text.length;
    }, 20);
    process.once("SIGTERM", () => {
      clearInterval(timer);
      writeFileSync(file("stream.ended"), "SIGTERM");
    });
  }
} else {
  fail(`fake xcrun: unknown command ${args.join(" ")}`);
}
