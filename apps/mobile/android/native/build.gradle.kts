@file:Suppress("UnstableApiUsage")

import java.io.File
import java.util.Locale
import java.util.Properties

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val rustProjectDir = rootProject.file("../core")
val rustTargetDir = rustProjectDir.resolve("target")
val rustJniLibsDir = layout.buildDirectory.dir("generated/rust-jniLibs")
val rustTarget = providers.gradleProperty("rustTarget").orElse("release")
val configuredNdkVersion = "28.2.13676358"

private data class AndroidAbi(
    val name: String,
    val rustTarget: String,
    val linkerPrefix: String,
    val api: Int,
)

private val androidAbis = listOf(
    AndroidAbi("arm64-v8a", "aarch64-linux-android", "aarch64-linux-android", 24),
    AndroidAbi("x86_64", "x86_64-linux-android", "x86_64-linux-android", 24),
    AndroidAbi("armeabi-v7a", "armv7-linux-androideabi", "armv7a-linux-androideabi", 24),
    AndroidAbi("x86", "i686-linux-android", "i686-linux-android", 24),
)

private val selectedAndroidAbis = providers.gradleProperty("fastvibeAbis")
    .map { value ->
        val requested = value.split(',').map(String::trim).filter(String::isNotEmpty).toSet()
        require(requested.isNotEmpty()) { "fastvibeAbis must name at least one Android ABI" }
        androidAbis.filter { it.name in requested }.also { selected ->
            val supported = selected.map(AndroidAbi::name).toSet()
            val unknown = requested - supported
            require(unknown.isEmpty()) {
                "Unsupported Android ABI(s): ${unknown.sorted().joinToString(", ")}. " +
                    "Supported: ${androidAbis.joinToString(", ") { it.name }}"
            }
        }
    }
    .orElse(listOf(androidAbis.first()))
    .get()

android {
    namespace = "dev.fastvibe.mobile.core"
    compileSdk = 35
    ndkVersion = configuredNdkVersion

    defaultConfig {
        minSdk = 24
        ndk { abiFilters += selectedAndroidAbis.map(AndroidAbi::name) }
        consumerProguardFiles("consumer-rules.pro")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures { buildConfig = false }
    externalNativeBuild {
        cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" }
    }
    sourceSets["main"].jniLibs.srcDir(rustJniLibsDir)
}

kotlin { jvmToolchain(17) }

dependencies {
    testImplementation("junit:junit:4.13.2")
}

fun Project.androidSdkDirectory(): File {
    val localProperties = rootProject.file("local.properties")
    if (localProperties.isFile) {
        val sdkDir = Properties().let { properties ->
            localProperties.inputStream().use(properties::load)
            properties.getProperty("sdk.dir")
        }
        if (!sdkDir.isNullOrBlank()) return file(sdkDir)
    }
    val environmentSdk = System.getenv("ANDROID_SDK_ROOT") ?: System.getenv("ANDROID_HOME")
    return environmentSdk?.takeIf(String::isNotBlank)?.let(::file)
        ?: error("Android SDK not found. Set sdk.dir in apps/mobile/android/local.properties or ANDROID_SDK_ROOT.")
}

fun Project.ndkDirectory(): File {
    val sdk = androidSdkDirectory()
    val ndk = sdk.resolve("ndk").resolve(configuredNdkVersion)
    return ndk.takeIf(File::isDirectory)
        ?: error("Android NDK $configuredNdkVersion not found at $ndk. Install it with sdkmanager.")
}

fun Project.ndkHostDirectory(ndk: File): File {
    val prebuilt = ndk.resolve("toolchains/llvm/prebuilt")
    val candidates = prebuilt.listFiles()?.filter(File::isDirectory).orEmpty()
    val os = System.getProperty("os.name").lowercase(Locale.ROOT)
    val preferred = when {
        os.contains("mac") -> listOf("darwin-arm64", "darwin-x86_64")
        os.contains("linux") -> listOf("linux-x86_64")
        os.contains("windows") -> listOf("windows-x86_64")
        else -> emptyList()
    }
    return preferred.asSequence().map(prebuilt::resolve).firstOrNull(File::isDirectory)
        ?: candidates.firstOrNull()
        ?: error("Android NDK toolchain not found under $prebuilt")
}

fun Project.rustExecutable(): String = providers.gradleProperty("rustExecutable").orElse("cargo").get()

private fun Project.runRustAndroidBuild(abi: AndroidAbi, outputDir: File) {
    val ndk = ndkDirectory()
    val hostDir = ndkHostDirectory(ndk)
    val clang = hostDir.resolve("bin/${abi.linkerPrefix}${abi.api}-clang")
    val cxx = hostDir.resolve("bin/${abi.linkerPrefix}${abi.api}-clang++")
    val ar = hostDir.resolve("bin/llvm-ar")
    require(clang.isFile) { "Android linker not found at $clang. Check NDK $configuredNdkVersion." }
    require(cxx.isFile) { "Android C++ linker not found at $cxx. Check NDK $configuredNdkVersion." }
    require(ar.isFile) { "Android archiver not found at $ar. Check NDK $configuredNdkVersion." }
    require(rustProjectDir.resolve("Cargo.toml").isFile) { "Rust core Cargo.toml not found at ${rustProjectDir.resolve("Cargo.toml")}" }

    val targetEnv = abi.rustTarget.uppercase(Locale.ROOT).replace('-', '_')
    val compiler = clang.absolutePath
    val command = listOf(
        rustExecutable(),
        "build",
        "--locked",
        "--manifest-path", rustProjectDir.resolve("Cargo.toml").absolutePath,
        "--lib",
        "--target", abi.rustTarget,
        "--${rustTarget.get()}",
    )
    val process = ProcessBuilder(command)
        .directory(rustProjectDir)
        .inheritIO()
        .apply {
            environment()["CARGO_TARGET_${targetEnv}_LINKER"] = compiler
            environment()["CARGO_TARGET_${targetEnv}_AR"] = ar.absolutePath
            environment()["AR_${abi.rustTarget}"] = ar.absolutePath
            environment()["AR_${targetEnv}"] = ar.absolutePath
            environment()["CC_${abi.rustTarget}"] = compiler
            environment()["CC_${targetEnv}"] = compiler
            environment()["CXX_${abi.rustTarget}"] = cxx.absolutePath
            environment()["CXX_${targetEnv}"] = cxx.absolutePath
            environment()["AR"] = ar.absolutePath
        }
        .start()
    if (!process.waitFor().let { exitCode -> exitCode == 0 }) {
        error("Cargo failed for Android ABI ${abi.name}; rerun :native:buildRustAndroid for compiler diagnostics")
    }

    val builtLibrary = rustTargetDir.resolve("${abi.rustTarget}/${rustTarget.get()}/libfastvibe_mobile_core.so")
    require(builtLibrary.isFile) { "Rust build completed without producing $builtLibrary" }
    val abiDir = outputDir.resolve(abi.name).also(File::mkdirs)
    copy {
        from(builtLibrary)
        into(abiDir)
    }
}

val buildRustAndroid = tasks.register("buildRustAndroid") {
    description = "Build the Rust mobile core for every packaged Android ABI."
    group = "native"
    inputs.property("abis", selectedAndroidAbis.map { "${it.name}:${it.rustTarget}:${it.api}" })
    inputs.property("profile", rustTarget)
    inputs.property("ndkVersion", configuredNdkVersion)
    inputs.files(rustProjectDir.resolve("Cargo.toml"), rustProjectDir.resolve("Cargo.lock"))
    inputs.dir(rustProjectDir.resolve("src"))
    inputs.dir(rustProjectDir.resolve("vendor"))
    outputs.dir(rustJniLibsDir)
    outputs.upToDateWhen {
        selectedAndroidAbis.all { abi ->
            rustJniLibsDir.get().asFile.resolve("${abi.name}/libfastvibe_mobile_core.so").isFile
        }
    }
    doFirst { delete(rustJniLibsDir.get().asFile) }
    doLast {
        val outputDir = rustJniLibsDir.get().asFile
        selectedAndroidAbis.forEach { runRustAndroidBuild(it, outputDir) }
    }
}

tasks.named("preBuild") { dependsOn(buildRustAndroid) }
tasks.register("buildAar") {
    description = "Build the distributable FastVibe Rust core AAR."
    group = "distribution"
    dependsOn("assembleRelease")
    doLast {
        val aar = layout.buildDirectory.file("outputs/aar/native-release.aar").get().asFile
        require(aar.isFile) { "AAR task completed without producing $aar" }
        logger.lifecycle("Rust core AAR: ${aar.absolutePath}")
    }
}
