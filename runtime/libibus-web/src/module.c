/* SPDX-FileCopyrightText: 2026 Synapdeck, Inc.
 * SPDX-License-Identifier: LGPL-2.1-or-later */

#include "ops.h"

#include <dlfcn.h>
#include <errno.h>
#include <sys/stat.h>

struct _IBusWebModule {
  char *name;
  /* The first failure while adding operations, so a module's init needn't
   * check each one. */
  int error;
  IBusWebPersist persist;
  IBusWebShutdown shutdown;
};

/* Every module registered, in order; each lives as long as the runtime. */
static GPtrArray *modules;

const char *ibusweb_module_get_name(IBusWebModule *module) {
  return module->name;
}

int ibusweb_module_add_op(IBusWebModule *module, uint32_t opcode,
                          const char *name, IBusWebOp op) {
  g_return_val_if_fail(module != NULL, -EINVAL);

  int ret = (name == NULL || op == NULL)
                ? -EINVAL
                : ibusweb_ops_add(module, opcode, name, op);
  if (ret < 0 && module->error == 0)
    module->error = ret;
  return ret;
}

int ibusweb_module_set_persist(IBusWebModule *module, IBusWebPersist persist) {
  g_return_val_if_fail(module != NULL, -EINVAL);

  if (persist == NULL) {
    if (module->error == 0)
      module->error = -EINVAL;
    return -EINVAL;
  }
  module->persist = persist;
  return 0;
}

int ibusweb_module_set_shutdown(IBusWebModule *module,
                                IBusWebShutdown shutdown) {
  g_return_val_if_fail(module != NULL, -EINVAL);

  if (shutdown == NULL) {
    if (module->error == 0)
      module->error = -EINVAL;
    return -EINVAL;
  }
  module->shutdown = shutdown;
  return 0;
}

void ibusweb_modules_shutdown(void) {
  if (modules == NULL)
    return;
  for (guint i = modules->len; i > 0; i--) {
    IBusWebModule *module = g_ptr_array_index(modules, i - 1);
    if (module->shutdown != NULL)
      module->shutdown();
  }
}

void ibusweb_modules_persist(void) {
  if (modules == NULL)
    return;
  for (guint i = 0; i < modules->len; i++) {
    IBusWebModule *module = g_ptr_array_index(modules, i);
    if (module->persist != NULL)
      module->persist();
  }
}

int ibusweb_register_module(const char *name, IBusWebModuleInit init,
                            IBusWebModule **module_out) {
  if (module_out != NULL)
    *module_out = NULL;
  g_return_val_if_fail(name != NULL, -EINVAL);
  g_return_val_if_fail(init != NULL, -EINVAL);

  IBusWebModule *module = g_new0(IBusWebModule, 1);
  module->name = g_strdup(name);
  init(module);

  int error = module->error;
  if (error < 0) {
    ibusweb_ops_remove_module(module);
    g_free(module->name);
    g_free(module);
    return error;
  }
  if (modules == NULL)
    modules = g_ptr_array_new();
  g_ptr_array_add(modules, module);
  if (module_out != NULL)
    *module_out = module;
  return 0;
}

int ibusweb_load_module(const char *path, IBusWebModule **module_out) {
  if (module_out != NULL)
    *module_out = NULL;
  g_return_val_if_fail(path != NULL, -EINVAL);

  /* Every side module exports the same entry point; kept out of the global
   * namespace, each one's dlsym() finds its own. */
  void *handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (handle == NULL) {
    g_warning("Can't load side module %s: %s", path, dlerror());
    /* dlerror() only describes the failure in prose. */
    struct stat st;
    return stat(path, &st) != 0 && errno == ENOENT ? -ENOENT : -ENOEXEC;
  }

  IBusWebModuleInit init =
      (IBusWebModuleInit)dlsym(handle, "ibusweb_module_init");
  if (init == NULL) {
    g_warning("Side module %s has no ibusweb_module_init", path);
    dlclose(handle);
    return -ENOEXEC;
  }

  int ret = ibusweb_register_module(path, init, module_out);
  if (ret < 0)
    dlclose(handle);
  return ret;
}
