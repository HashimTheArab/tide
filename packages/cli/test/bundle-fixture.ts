// A deterministic Metro-shaped bundle in two versions, for the patch size test.
import { prng } from "./helpers.ts";

/** One module; dependencies are paths, so IDs come only from position when serialised. */
export interface BundleModule {
  readonly path: string;
  readonly body: string;
  readonly deps: readonly string[];
}

const WORDS = (
  "value count index render props state children style theme layout navigation route params screen " +
  "button label title text image source width height color margin padding border radius opacity flex " +
  "onPress onChange onSubmit onLayout useState useEffect useMemo useCallback useRef useContext context " +
  "provider dispatch action reducer payload selector store fetch response request headers status error " +
  "message loading data items list key id name type format locale currency amount price total user " +
  "account session token refresh expires timestamp duration animation timing spring easing transform"
).split(" ");
const LOCALS = "abcdefghijklmnopqrstuvwxyz".split("");

/** Returns minified-looking code drawn from `r`. */
function code(r: () => number) {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)] as T;
  const word = () => pick(WORDS);
  const num = () => Math.floor(r() * 10_000);
  const statement = (): string => {
    const a = pick(LOCALS);
    const b = pick(LOCALS);
    switch (Math.floor(r() * 6)) {
      case 0:
        return `function ${a}(${b},t){return ${b}.${word()}(t,"${word()}-${num()}")}`;
      case 1:
        return `var ${a}=${b}.${word()}||{${word()}:${num()},${word()}:"${word()}"};`;
      case 2:
        return `e.${word()}=function(${b}){return ${b}&&${b}.${word()}?${num()}:${a}(${b})};`;
      case 3:
        return `if(${a}.${word()}===${num()})throw new Error("${word()} ${word()} ${word()}");`;
      case 4:
        return `${a}.${word()}.${word()}({${word()}:${b},${word()}:${num()}});`;
      default:
        return `return(0,${a}.default)(${b}.${word()},[${num()},${num()}]);`;
    }
  };
  /** A module body that loads its `deps` dependencies through `_dependencyMap` (`d`), as Metro does. */
  const body = (deps: number): string => {
    const imports = Array.from({ length: deps }, (_, i) => `${LOCALS[i % 26]}${i}=r(d[${i}])`);
    const lines = Array.from({ length: 4 + Math.floor(r() * 10) }, statement);
    return `"use strict";var ${imports.join(",") || "_=0"};${lines.join("")}`;
  };
  return { r, word, statement, body };
}

/**
 * Returns version 1 and version 2. Version 2 edits about 1% of bodies, changes a few strings, removes one module
 * near the end and inserts one near the start, so every module between them gets a new ID.
 */
export function bundleVersions(): { v1: BundleModule[]; v2: BundleModule[] } {
  const first = code(prng(20261120));
  const count = 3900;
  const paths = Array.from(
    { length: count },
    (_, i) => `src/${WORDS[i % WORDS.length]}/${WORDS[(i * 7) % WORDS.length]}${i}.js`,
  );
  const v1 = paths.map((path) => {
    const deps = Array.from({ length: Math.floor(first.r() * 7) }, () => {
      return paths[Math.floor(first.r() * count)] ?? "";
    });
    return { path, body: first.body(deps.length), deps };
  });

  // A second sequence makes every edit, so the first one never shifts.
  const edit = code(prng(7));
  const v2 = v1.map((m) => {
    const roll = edit.r();
    if (roll < 0.01) {
      const at = m.body.indexOf(";", m.body.length >> 1) + 1;
      return { ...m, body: `${m.body.slice(0, at)}${edit.statement()}${m.body.slice(at)}` };
    }
    if (roll < 0.012) return { ...m, body: m.body.replace(/"[a-z]+/, `"${edit.word()}`) };
    return m;
  });
  const [removed] = v2.splice(count - 3, 1);
  const dropped = v2.map((m) => ({ ...m, deps: m.deps.filter((d) => d !== removed?.path) }));
  const added = { path: "src/added/feature.js", body: edit.body(1), deps: [paths[0] ?? ""] };
  dropped.splice(4, 0, added);
  return { v1, v2: dropped };
}

/** Returns the bundle bytes: a prelude, then one `__d` call per module with IDs by position. */
export function serialiseBundle(list: readonly BundleModule[]): Uint8Array<ArrayBuffer> {
  const ids = new Map(list.map((m, i) => [m.path, i]));
  const modules = list.map((m, i) => {
    const deps = m.deps.map((p) => ids.get(p)).join(",");
    return `__d(function(g,r,i,a,m,e,d){${m.body}},${i},[${deps}],"${m.path}");\n`;
  });
  const prelude =
    "var __BUNDLE_START_TIME__=this.nativePerformanceNow?nativePerformanceNow():Date.now()," +
    "__DEV__=false,process=this.process||{};\n";
  return new Uint8Array(new TextEncoder().encode(`${prelude}${modules.join("")}__r(0);\n`));
}
