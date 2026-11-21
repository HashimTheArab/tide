// The conformance app: reports the update it runs, then checks, fetches and reloads itself so each launch is one
// deterministic step. The harness reads the reports from logcat; `marker.js` is written per build or update.
import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";

import { MARKER } from "./marker";

const PREFIX = "tide-conformance ";

export default function App() {
  const [lines, setLines] = useState([]);
  useEffect(() => {
    const report = (event, fields) => {
      const line = PREFIX + JSON.stringify({ event, marker: MARKER, ...fields });
      console.log(line);
      setLines((shown) => [...shown, line]);
    };
    report("running", { updateId: Updates.updateId, embedded: Updates.isEmbeddedLaunch });
    (async () => {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable && !check.isRollBackToEmbedded)
        return report("check", { result: "none" });
      report("check", { result: check.isRollBackToEmbedded ? "rollback" : "update" });
      const fetched = await Updates.fetchUpdateAsync();
      report("fetched", { isNew: fetched.isNew, rollback: fetched.isRollBackToEmbedded });
      await Updates.reloadAsync();
    })().catch((e) => report("error", { message: String(e?.message ?? e) }));
  }, []);
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
      <Image source={require("./image.png")} style={{ width: 16, height: 16 }} />
      {lines.map((line) => (
        <Text key={line}>{line}</Text>
      ))}
    </View>
  );
}
