// Lets the Android release build reach the harness's local Tide over plain HTTP on 127.0.0.1. iOS needs nothing: the
// Info.plist from Expo's iOS template already sets NSAllowsLocalNetworking.
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = (config) =>
  withAndroidManifest(config, (mod) => {
    mod.modResults.manifest.application[0].$["android:usesCleartextTraffic"] = "true";
    return mod;
  });
