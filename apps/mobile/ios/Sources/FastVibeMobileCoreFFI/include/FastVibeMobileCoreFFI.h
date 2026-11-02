#ifndef FASTVIBE_MOBILE_CORE_FFI_H
#define FASTVIBE_MOBILE_CORE_FFI_H

#include "../../../../core/include/fastvibe_mobile_core.h"

#ifdef __cplusplus
extern "C" {
#endif

/* SwiftPM can test without an artifact; the iOS app resolves these symbols from Rust. */
void *fastvibe_mobile_core_bridge_create(void);
void fastvibe_mobile_core_bridge_destroy(void *handle);
char *fastvibe_mobile_core_bridge_version(void);
char *fastvibe_mobile_core_bridge_command_json(void *handle, const char *input);
void fastvibe_mobile_core_bridge_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif /* FASTVIBE_MOBILE_CORE_FFI_H */
