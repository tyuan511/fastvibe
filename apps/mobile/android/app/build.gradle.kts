import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val mobileVersion = Properties().apply {
    rootProject.file("version.properties").inputStream().use(::load)
}
val mobileVersionName = mobileVersion.getProperty("versionName") ?: error("versionName missing from version.properties")
val mobileVersionCode = mobileVersion.getProperty("versionCode")?.toIntOrNull()
    ?: error("versionCode missing from version.properties")
require(mobileVersionCode >= 511) { "versionCode must remain above the Flutter release 510" }
val selectedFastvibeAbis = providers.gradleProperty("fastvibeAbis")
    .orNull
    ?.split(',')
    ?.map(String::trim)
    ?.filter(String::isNotEmpty)
    ?: listOf("arm64-v8a")

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
    compileSdk = 35
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
        targetSdk = 35
        versionCode = mobileVersionCode
        versionName = mobileVersionName
        ndk { abiFilters += selectedFastvibeAbis }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    packaging {
        jniLibs { useLegacyPackaging = true }
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    buildTypes {
        debug {
            if (providers.gradleProperty("fastvibeVisualReview").orNull == "true") {
                applicationIdSuffix = ".visual"
            }
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("production")
        }
    }
}

kotlin {
    jvmToolchain(17)
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    implementation(project(":native"))
    implementation(platform("androidx.compose:compose-bom:2025.04.01"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("dev.chrisbanes.haze:haze:1.5.3")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("io.noties.markwon:core:4.6.2")
    implementation("io.noties.markwon:ext-tables:4.6.2")
    implementation("io.noties.markwon:ext-strikethrough:4.6.2")
    implementation("io.noties.markwon:ext-tasklist:4.6.2")
    implementation("io.noties.markwon:linkify:4.6.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.04.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
