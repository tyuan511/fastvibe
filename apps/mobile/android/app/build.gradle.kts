import java.util.Properties

plugins {
    id("com.android.application")
    id("dev.flutter.flutter-gradle-plugin")
}

val mobileVersion = Properties().apply {
    rootProject.file("version.properties").inputStream().use(::load)
}
val mobileVersionName = mobileVersion.getProperty("versionName") ?: error("versionName missing from version.properties")
val mobileVersionCode = mobileVersion.getProperty("versionCode")?.toIntOrNull()
    ?: error("versionCode missing from version.properties")
require(mobileVersionCode >= 513) { "versionCode must not fall below the current installed release 513" }
require(flutter.versionName == mobileVersionName && flutter.versionCode == mobileVersionCode) {
    "Flutter pubspec version and android/version.properties must match"
}

val releaseStoreFile = System.getenv("FASTVIBE_ANDROID_STORE_FILE")
val releaseStorePassword = System.getenv("FASTVIBE_ANDROID_STORE_PASSWORD")
val releaseKeyAlias = System.getenv("FASTVIBE_ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("FASTVIBE_ANDROID_KEY_PASSWORD") ?: releaseStorePassword
val releaseSigning = listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword)
val releaseTaskRequested = gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }
if (releaseTaskRequested) {
    require(releaseSigning.none { it.isNullOrBlank() }) {
        "Production release builds require FASTVIBE_ANDROID_STORE_FILE, " +
            "FASTVIBE_ANDROID_STORE_PASSWORD, FASTVIBE_ANDROID_KEY_ALIAS, and " +
            "FASTVIBE_ANDROID_KEY_PASSWORD"
    }
}
require(releaseSigning.all { it.isNullOrBlank() } || releaseSigning.none { it.isNullOrBlank() }) {
    "All FASTVIBE_ANDROID signing settings must be supplied together"
}

android {
    namespace = "dev.fastvibe.mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = "28.2.13676358"

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

    defaultConfig {
        applicationId = "dev.fastvibe.mobile"
        minSdk = 24
        targetSdk = flutter.targetSdkVersion
        versionCode = mobileVersionCode
        versionName = mobileVersionName
        // Flutter selects the ABI through --target-platform / --split-per-abi.
        // defaultConfig abiFilters conflicts with per-ABI Release packaging.
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    packaging {
        jniLibs { useLegacyPackaging = true }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.findByName("production")
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
