SCRIPT_NAME := windowgeometryrestore
PKGFILE := $(SCRIPT_NAME).kwinscript
SRC_DIR := src

.PHONY: build test test-kwin install uninstall clean logs load unload reload

build: $(PKGFILE)

# Rebuilt from scratch: zip -r would keep files that were deleted from the source.
$(PKGFILE): $(shell find $(SRC_DIR) -type f)
	@rm -f $@
	@zip -rq $@ $(SRC_DIR)

test:
	node tests/engine.mjs && node tests/lifecycle.mjs

# Scenarios against a real, headless KWin with virtual monitors (dev container only:
# needs kwin, pywayland, gcc, wayland-devel, plasma-wayland-protocols-devel, qt6-qtbase-devel).
# K=name runs the scenarios whose name contains it.
test-kwin:
	cd /var/tmp && python3 -I $(CURDIR)/tests/kwin/scenarios.py $(if $(K),-k $(K))

# Install or upgrade and enable. An upgrade runs from the next login (KWin caches scripts).
install:
	@./install.sh

uninstall:
	@./install.sh --uninstall

clean:
	@rm -f $(PKGFILE)

logs:
	@journalctl --user -f | grep --line-buffered -i windowgeometryrestore

# Load the working tree as a separate script for quick testing without logging out:
# each load uses a fresh copy, which sidesteps KWin's script cache. Disable the
# installed script first so the two don't both act on windows.
load:
	bin/load.sh "$(SRC_DIR)" "$(SCRIPT_NAME)-test"

unload:
	bin/unload.sh "$(SCRIPT_NAME)-test"

reload: unload load
