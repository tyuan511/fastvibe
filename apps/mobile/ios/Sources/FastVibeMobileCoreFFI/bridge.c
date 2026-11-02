#include "FastVibeMobileCoreFFI.h"

#include <dlfcn.h>

typedef void *(*create_function)(void);
typedef void (*destroy_function)(void *);
typedef char *(*string_function)(void);
typedef char *(*command_function)(void *, const char *);
typedef void (*free_function)(char *);

static void *rust_symbol(const char *name) { return dlsym(RTLD_DEFAULT, name); }

void *fastvibe_mobile_core_bridge_create(void) {
    create_function function = (create_function)rust_symbol("fv_mobile_core_create");
    return function == NULL ? NULL : function();
}

void fastvibe_mobile_core_bridge_destroy(void *handle) {
    destroy_function function = (destroy_function)rust_symbol("fv_mobile_core_destroy");
    if (function != NULL) function(handle);
}

char *fastvibe_mobile_core_bridge_version(void) {
    string_function function = (string_function)rust_symbol("fv_mobile_core_version");
    return function == NULL ? NULL : function();
}

char *fastvibe_mobile_core_bridge_command_json(void *handle, const char *input) {
    command_function function = (command_function)rust_symbol("fv_mobile_core_command_json");
    return function == NULL ? NULL : function(handle, input);
}

void fastvibe_mobile_core_bridge_free_string(char *value) {
    free_function function = (free_function)rust_symbol("fv_mobile_core_free_string");
    if (function != NULL) function(value);
}
