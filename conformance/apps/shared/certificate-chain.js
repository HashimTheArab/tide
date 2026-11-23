// Opts the app in to the replies' certificate_chain part, which no app-config field does.
const { AndroidConfig, withAndroidManifest, withExpoPlist } = require("expo/config-plugins");

module.exports = (config) =>
  withExpoPlist(
    withAndroidManifest(config, (mod) => {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(
        AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults),
        "expo.modules.updates.CODE_SIGNING_INCLUDE_MANIFEST_RESPONSE_CERTIFICATE_CHAIN",
        "true",
      );
      return mod;
    }),
    (mod) => {
      mod.modResults.EXUpdatesCodeSigningIncludeManifestResponseCertificateChain = true;
      return mod;
    },
  );
