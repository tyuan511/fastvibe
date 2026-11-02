# Keep the public bridge and its JNI entry points in applications that enable shrinking.
-keep class dev.fastvibe.mobile.core.RustCoreBridge { *; }
-keepclasseswithmembers,includedescriptorclasses class * {
    native <methods>;
}
