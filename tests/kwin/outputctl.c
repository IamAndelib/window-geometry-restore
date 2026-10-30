// outputctl: reconfigure KWin's outputs through kde_output_management_v2
// for the KWin sandbox tests (tests/kwin/sandbox.py builds and runs it).
// Taken from kde-snap-overlay's test bed.
//
//   outputctl NAME[:enabled=0|1][:x=N:y=N][:scale=F] ...
//
// All changes go into one configuration. Exit 0 once KWin reports it
// applied, 1 if KWin refused it (reason on stderr), 2 on usage/setup errors.
//
// KWin 6.7 announces output devices through a registry event carrying a
// new_id, which pywayland cannot receive; hence this small C client. Events
// are taken with generic dispatchers, so the listener tables of these large,
// fast-moving protocols never have to match the compositor's version.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>

#include "kde-output-device-v2-client-protocol.h"
#include "kde-output-management-v2-client-protocol.h"

#define MAX_OUTPUTS 16

struct device {
    struct kde_output_device_v2 *proxy;
    char name[64];
};

static struct device devices[MAX_OUTPUTS];
static int device_count;
static struct kde_output_management_v2 *management;
static int result = -1; // -1 pending, 0 applied, 1 failed

static int device_dispatch(const void *data, void *target, uint32_t opcode,
                           const struct wl_message *msg, union wl_argument *args)
{
    (void)target;
    (void)opcode;
    struct device *dev = (struct device *)data;
    if (strcmp(msg->name, "name") == 0 && args[0].s) {
        snprintf(dev->name, sizeof dev->name, "%s", args[0].s);
    }
    return 0;
}

static int registry_dispatch(const void *data, void *target, uint32_t opcode,
                             const struct wl_message *msg, union wl_argument *args)
{
    (void)data;
    (void)target;
    (void)opcode;
    if (strcmp(msg->name, "output") == 0 && device_count < MAX_OUTPUTS) {
        struct device *dev = &devices[device_count++];
        dev->proxy = (struct kde_output_device_v2 *)args[0].o;
        wl_proxy_add_dispatcher((struct wl_proxy *)dev->proxy, device_dispatch, dev, NULL);
    }
    return 0;
}

static int config_dispatch(const void *data, void *target, uint32_t opcode,
                           const struct wl_message *msg, union wl_argument *args)
{
    (void)data;
    (void)target;
    (void)opcode;
    if (strcmp(msg->name, "applied") == 0) {
        result = 0;
    } else if (strcmp(msg->name, "failed") == 0) {
        result = 1;
    } else if (strcmp(msg->name, "failure_reason") == 0 && args[0].s) {
        fprintf(stderr, "failure_reason: %s\n", args[0].s);
    }
    return 0;
}

static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version)
{
    (void)data;
    if (strcmp(interface, kde_output_device_registry_v2_interface.name) == 0) {
        uint32_t v = version < 23 ? version : 23;
        void *outputs = wl_registry_bind(registry, name, &kde_output_device_registry_v2_interface, v);
        wl_proxy_add_dispatcher((struct wl_proxy *)outputs, registry_dispatch, NULL, NULL);
    } else if (strcmp(interface, kde_output_management_v2_interface.name) == 0) {
        uint32_t v = version < 21 ? version : 21;
        management = wl_registry_bind(registry, name, &kde_output_management_v2_interface, v);
    }
}

static void global_remove(void *data, struct wl_registry *registry, uint32_t name)
{
    (void)data;
    (void)registry;
    (void)name;
}

static const struct wl_registry_listener registry_listener = {global, global_remove};

static struct device *find(const char *name)
{
    for (int i = 0; i < device_count; i++) {
        if (strcmp(devices[i].name, name) == 0) {
            return &devices[i];
        }
    }
    return NULL;
}

int main(int argc, char **argv)
{
    if (argc < 2) {
        fprintf(stderr, "usage: %s NAME[:enabled=0|1][:x=N:y=N][:scale=F] ...\n", argv[0]);
        return 2;
    }
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) {
        fprintf(stderr, "cannot connect to the Wayland display\n");
        return 2;
    }
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    // Globals, then the device announcements, then their properties.
    for (int i = 0; i < 3; i++) {
        wl_display_roundtrip(display);
    }
    if (!management || device_count == 0) {
        fprintf(stderr, "no output management or no output devices\n");
        return 2;
    }

    struct kde_output_configuration_v2 *config = kde_output_management_v2_create_configuration(management);
    wl_proxy_add_dispatcher((struct wl_proxy *)config, config_dispatch, NULL, NULL);
    for (int a = 1; a < argc; a++) {
        char spec[256];
        snprintf(spec, sizeof spec, "%s", argv[a]);
        char *save = NULL;
        char *name = strtok_r(spec, ":", &save);
        struct device *dev = name ? find(name) : NULL;
        if (!dev) {
            fprintf(stderr, "unknown output '%s'; known:", name ? name : "");
            for (int i = 0; i < device_count; i++) {
                fprintf(stderr, " %s", devices[i].name);
            }
            fprintf(stderr, "\n");
            return 2;
        }
        int x = 0, y = 0, has_pos = 0;
        for (char *kv = strtok_r(NULL, ":", &save); kv; kv = strtok_r(NULL, ":", &save)) {
            if (strncmp(kv, "enabled=", 8) == 0) {
                kde_output_configuration_v2_enable(config, dev->proxy, atoi(kv + 8));
            } else if (strncmp(kv, "x=", 2) == 0) {
                x = atoi(kv + 2);
                has_pos = 1;
            } else if (strncmp(kv, "y=", 2) == 0) {
                y = atoi(kv + 2);
                has_pos = 1;
            } else if (strncmp(kv, "scale=", 6) == 0) {
                kde_output_configuration_v2_scale(config, dev->proxy, wl_fixed_from_double(atof(kv + 6)));
            } else {
                fprintf(stderr, "bad setting '%s'\n", kv);
                return 2;
            }
        }
        if (has_pos) {
            kde_output_configuration_v2_position(config, dev->proxy, x, y);
        }
    }
    kde_output_configuration_v2_apply(config);
    while (result < 0 && wl_display_dispatch(display) != -1) {
    }
    wl_display_disconnect(display);
    if (result != 0) {
        fprintf(stderr, "KWin refused the output configuration\n");
        return 1;
    }
    return 0;
}
