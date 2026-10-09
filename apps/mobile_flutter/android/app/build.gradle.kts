plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Reuse the shipping mobile key when supplied by CI. Local builds remain installable
// test builds; they cannot replace a production installation signed with another key.
val releaseStoreFile = System.getenv("FASTVIBE_ANDROID_STORE_FILE")
val releaseStorePassword = System.getenv("FASTVIBE_ANDROID_STORE_PASSWORD")
val releaseKeyAlias = System.getenv("FASTVIBE_ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("FASTVIBE_ANDROID_KEY_PASSWORD") ?: releaseStorePassword
val releaseSigning = listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
require(releaseSigning.all { it.isNullOrBlank() } || releaseSigning.none { it.isNullOrBlank() }) {
    "All FASTVIBE_ANDROID signing settings must be supplied together"
}

android {
    signingConfigs {
        if (!releaseStoreFile.isNullOrBlank()) {
            create("production") {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    namespace = "dev.fastvibe.fastvibe_mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // flutter_local_notifications uses java.time on API levels below 26, which is
        // what core library desugaring back-ports. Without it the build fails outright
        // (`checkDebugAarMetadata`), not at runtime.
        isCoreLibraryDesugaringEnabled = true
    }

    defaultConfig {
        // Keep the shipping package ID so a release signed with the same key can
        // upgrade an existing installation.
        applicationId = "dev.fastvibe.mobile"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        // mobile_scanner's ML Kit and flutter_local_notifications both need 21+, and the
        // glass shaders want a modern Impeller path.
        minSdk = 24
        targetSdk = flutter.targetSdkVersion
        // Keep the shipping build number on the arm64 APK.
        // gradle.properties disables Flutter's per-ABI offset.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    packaging {
        jniLibs {
            // AGP stores native libraries uncompressed so they can be mapped straight out
            // of the APK. For an APK downloaded over a phone connection (the in-app
            // updater fetches one file) the download matters more than install-time
            // extraction: libflutter, libapp and the ML Kit scanner are most of the size.
            useLegacyPackaging = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName(if (releaseStoreFile.isNullOrBlank()) "debug" else "production")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}

flutter {
    source = "../.."
}
