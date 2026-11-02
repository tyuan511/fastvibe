cmake_minimum_required(VERSION 3.22.1)
project("fastvibe_core_jni")

set(RUST_LIB "${CMAKE_CURRENT_LIST_DIR}/../../../build/generated/rust-jniLibs/${ANDROID_ABI}/libfastvibe_mobile_core.so")

add_library(fastvibe_mobile_core SHARED IMPORTED GLOBAL)
set_target_properties(fastvibe_mobile_core PROPERTIES
    IMPORTED_LOCATION "${RUST_LIB}"
    IMPORTED_NO_SONAME TRUE
)

add_library(fastvibe_core_jni SHARED rust_core_jni.cpp)
find_library(log-lib log)
target_link_libraries(fastvibe_core_jni fastvibe_mobile_core ${log-lib})
