#ifndef FASTVIBE_MOBILE_CORE_H
#define FASTVIBE_MOBILE_CORE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Stable C ABI for fastvibe-mobile-core.
 *
 * All returned strings are UTF-8, NUL-terminated JSON allocated by Rust. The
 * caller must release them with fv_mobile_core_free_string(). Null is returned
 * for invalid input or an internal failure.
 */
char *fv_mobile_core_version(void);

/* Independent JSON runtime handle API. */
void *fv_mobile_core_create(void);
void fv_mobile_core_destroy(void *handle);
void fv_mobile_core_free(void *handle);
char *fv_mobile_core_command_json(void *handle, const char *input);
char *fv_mobile_core_command(void *handle, const char *input);
char *fv_mobile_core_poll_json(void *handle);
char *fv_mobile_core_poll(void *handle);

/* Compatibility reducer API. */
char *fv_mobile_core_apply_json(const char *input);
void fv_mobile_core_free_string(char *value);

#ifdef __cplusplus
}
#endif

#endif /* FASTVIBE_MOBILE_CORE_H */
