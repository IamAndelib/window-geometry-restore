SCRIPT_NAME := windowgeometryrestore
PKGFILE := $(SCRIPT_NAME).kwinscript
SRC_DIR := src

.PHONY: build test install uninstall clean logs load unload reload

build: $(PKGFILE)

# Rebuilt from scratch: zip -r would keep files that were deleted from the source.
$(PKGFILE): $(shell find $(SRC_DIR) -type f)
	@rm -f $@
	@zip -rq $@ $(SRC_DIR)

test:
	node tests/engine.mjs && node tests/lifecycle.mjs

# Install or upgrade, enable, and reload the running copy.
install:
	@./install.sh

uninstall:
	@./install.sh --uninstall

clean:
	@rm -f $(PKGFILE)

logs:
	@journalctl --user -f | grep --line-buffered WindowGeometryRestore

# Load the working tree as a separate script for quick testing (unload the installed one first).
load:
	bin/load.sh "$(SRC_DIR)" "$(SCRIPT_NAME)-test"

unload:
	bin/unload.sh "$(SCRIPT_NAME)-test"

reload: unload load
