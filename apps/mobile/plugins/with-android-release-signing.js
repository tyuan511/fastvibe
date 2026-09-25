const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "FASTVIBE_ANDROID_STORE_FILE";

/**
 * Configure the generated Android project to use the CI-managed upload key.
 *
 * The native project is deliberately not committed (CNG), so signing belongs in
 * the prebuild config rather than in android/app/build.gradle. Local builds keep
 * Expo's debug signing; CI supplies all four environment variables.
 */
module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== "groovy") {
      throw new Error("FastVibe Android signing requires a Groovy app build.gradle");
    }

    let contents = modConfig.modResults.contents;
    if (contents.includes(MARKER)) return modConfig;

    const buildTypes = "    buildTypes {";
    const buildTypesIndex = contents.indexOf(buildTypes);
    if (buildTypesIndex === -1) {
      throw new Error("FastVibe Android signing could not find the generated buildTypes block");
    }

    const signingConfig = `    signingConfigs {
        release {
            def storeFilePath = System.getenv("FASTVIBE_ANDROID_STORE_FILE")
            def storePasswordValue = System.getenv("FASTVIBE_ANDROID_STORE_PASSWORD")
            def keyAliasValue = System.getenv("FASTVIBE_ANDROID_KEY_ALIAS")
            def keyPasswordValue = System.getenv("FASTVIBE_ANDROID_KEY_PASSWORD")
            if ([storeFilePath, storePasswordValue, keyAliasValue, keyPasswordValue].any { !it }) {
                throw new GradleException("FastVibe release signing credentials are missing")
            }
            storeFile file(storeFilePath)
            storePassword storePasswordValue
            keyAlias keyAliasValue
            keyPassword keyPasswordValue
        }
    }

`;
    contents = contents.slice(0, buildTypesIndex) + signingConfig + contents.slice(buildTypesIndex);

    const releaseBuildTypeIndex = contents.indexOf("        release {", buildTypesIndex + signingConfig.length);
    if (releaseBuildTypeIndex === -1) {
      throw new Error("FastVibe Android signing could not find the generated release build type");
    }
    const debugSigning = "            signingConfig signingConfigs.debug";
    const debugSigningIndex = contents.indexOf(debugSigning, releaseBuildTypeIndex);
    if (debugSigningIndex === -1) {
      throw new Error("FastVibe Android signing could not find the debug release signing config");
    }
    contents = `${contents.slice(0, debugSigningIndex)}            signingConfig signingConfigs.release${contents.slice(debugSigningIndex + debugSigning.length)}`;

    modConfig.modResults.contents = contents;
    return modConfig;
  });
};
