#include <jni.h>

#include <cstdint>
#include <string>

extern "C" {
char* fv_mobile_core_version();
char* fv_mobile_core_apply_json(const char* input);
void* fv_mobile_core_create();
void fv_mobile_core_destroy(void* handle);
char* fv_mobile_core_command_json(void* handle, const char* input);
void fv_mobile_core_free_string(char* value);
}

namespace {

std::string utf16_to_utf8(const jchar* chars, jsize length) {
    std::string result;
    result.reserve(static_cast<size_t>(length));
    for (jsize index = 0; index < length; ++index) {
        uint32_t codepoint = chars[index];
        if (codepoint >= 0xD800 && codepoint <= 0xDBFF && index + 1 < length) {
            const uint32_t low = chars[index + 1];
            if (low >= 0xDC00 && low <= 0xDFFF) {
                codepoint = 0x10000 + ((codepoint - 0xD800) << 10) + (low - 0xDC00);
                ++index;
            }
        }
        if (codepoint <= 0x7F) {
            result.push_back(static_cast<char>(codepoint));
        } else if (codepoint <= 0x7FF) {
            result.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
            result.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        } else if (codepoint <= 0xFFFF) {
            result.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
            result.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        } else {
            result.push_back(static_cast<char>(0xF0 | (codepoint >> 18)));
            result.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
            result.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
        }
    }
    return result;
}

jstring utf8_to_jstring(JNIEnv* env, const char* bytes) {
    if (bytes == nullptr) return nullptr;
    std::u16string result;
    const auto* input = reinterpret_cast<const uint8_t*>(bytes);
    for (size_t index = 0; input[index] != 0;) {
        uint32_t codepoint = 0xFFFD;
        const uint8_t first = input[index++];
        if (first <= 0x7F) {
            codepoint = first;
        } else if ((first & 0xE0) == 0xC0 && input[index] != 0) {
            const uint8_t second = input[index++];
            if ((second & 0xC0) == 0x80) codepoint = ((first & 0x1F) << 6) | (second & 0x3F);
        } else if ((first & 0xF0) == 0xE0 && input[index] != 0 && input[index + 1] != 0) {
            const uint8_t second = input[index++];
            const uint8_t third = input[index++];
            if ((second & 0xC0) == 0x80 && (third & 0xC0) == 0x80) {
                codepoint = ((first & 0x0F) << 12) | ((second & 0x3F) << 6) | (third & 0x3F);
            }
        } else if ((first & 0xF8) == 0xF0 && input[index] != 0 && input[index + 1] != 0 && input[index + 2] != 0) {
            const uint8_t second = input[index++];
            const uint8_t third = input[index++];
            const uint8_t fourth = input[index++];
            if ((second & 0xC0) == 0x80 && (third & 0xC0) == 0x80 && (fourth & 0xC0) == 0x80) {
                codepoint = ((first & 0x07) << 18) | ((second & 0x3F) << 12) | ((third & 0x3F) << 6) | (fourth & 0x3F);
            }
        }
        if (codepoint <= 0xFFFF) {
            result.push_back(static_cast<char16_t>(codepoint));
        } else if (codepoint <= 0x10FFFF) {
            codepoint -= 0x10000;
            result.push_back(static_cast<char16_t>(0xD800 | (codepoint >> 10)));
            result.push_back(static_cast<char16_t>(0xDC00 | (codepoint & 0x3FF)));
        } else {
            result.push_back(static_cast<char16_t>(0xFFFD));
        }
    }
    return env->NewString(reinterpret_cast<const jchar*>(result.data()), static_cast<jsize>(result.size()));
}

jstring apply_rust_json(JNIEnv* env, jstring input) {
    if (input == nullptr) return nullptr;
    const jsize length = env->GetStringLength(input);
    const jchar* chars = env->GetStringChars(input, nullptr);
    if (chars == nullptr) return nullptr;
    const std::string utf8 = utf16_to_utf8(chars, length);
    env->ReleaseStringChars(input, chars);

    char* output = fv_mobile_core_apply_json(utf8.c_str());
    if (output == nullptr) return nullptr;
    jstring result = utf8_to_jstring(env, output);
    fv_mobile_core_free_string(output);
    return result;
}

jstring command_rust_json(JNIEnv* env, jstring input) {
    if (input == nullptr) return nullptr;
    const jsize length = env->GetStringLength(input);
    const jchar* chars = env->GetStringChars(input, nullptr);
    if (chars == nullptr) return nullptr;
    const std::string utf8 = utf16_to_utf8(chars, length);
    env->ReleaseStringChars(input, chars);

    static void* runtime = fv_mobile_core_create();
    if (runtime == nullptr) return nullptr;
    char* output = fv_mobile_core_command_json(runtime, utf8.c_str());
    if (output == nullptr) return nullptr;
    jstring result = utf8_to_jstring(env, output);
    fv_mobile_core_free_string(output);
    return result;
}
}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_dev_fastvibe_mobile_core_RustCoreBridge_nativeVersion(JNIEnv* env, jclass) {
    char* version = fv_mobile_core_version();
    if (version == nullptr) return nullptr;
    jstring result = utf8_to_jstring(env, version);
    fv_mobile_core_free_string(version);
    return result;
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_fastvibe_mobile_core_RustCoreBridge_nativeApplyJson(JNIEnv* env, jclass, jstring input) {
    return apply_rust_json(env, input);
}

extern "C" JNIEXPORT jstring JNICALL
Java_dev_fastvibe_mobile_core_RustCoreBridge_nativeCommandJson(JNIEnv* env, jclass, jstring input) {
    return command_rust_json(env, input);
}
