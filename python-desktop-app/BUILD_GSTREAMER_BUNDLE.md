# Build Script Enhancement - GStreamer Plugin Bundling

## Changes to build.sh

Add this section after "Installing AppRun and desktop metadata..." (around line 220):

```bash
# ============================================================================
# Bundle GStreamer plugins for Wayland screenshot capture
# ============================================================================
echo "  Bundling GStreamer plugins..."

GST_PLUGIN_DIRS=(
    "/usr/lib/x86_64-linux-gnu/gstreamer-1.0"
    "/usr/lib64/gstreamer-1.0"
    "/usr/lib/gstreamer-1.0"
)

# Find GStreamer plugin directory
GST_PLUGIN_DIR=""
for dir in "${GST_PLUGIN_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        GST_PLUGIN_DIR="$dir"
        break
    fi
done

if [ -n "$GST_PLUGIN_DIR" ]; then
    echo "  Found GStreamer plugins at: $GST_PLUGIN_DIR"
    
    # Create plugin directory in AppDir
    mkdir -p "${APPDIR}/usr/lib/gstreamer-1.0"
    
    # Bundle essential plugins for screenshot capture
    REQUIRED_PLUGINS=(
        "libgstpipewiresrc.so"
        "libgstvideoconvert.so"
        "libgstvideoconvertscale.so"
        "libgstpngenc.so"
        "libgstpng.so"
        "libgstcoreelements.so"
        "libgstvideobox.so"
        "libgstvideoscale.so"
        "libgstvideorate.so"
        "libgstvideofilter.so"
        "libgstapp.so"
        "libgsttypefindfunctions.so"
        "libgstplayback.so"
    )
    
    BUNDLED_COUNT=0
    for plugin in "${REQUIRED_PLUGINS[@]}"; do
        if [ -f "${GST_PLUGIN_DIR}/${plugin}" ]; then
            cp "${GST_PLUGIN_DIR}/${plugin}" "${APPDIR}/usr/lib/gstreamer-1.0/"
            BUNDLED_COUNT=$((BUNDLED_COUNT + 1))
        fi
    done
    
    if [ $BUNDLED_COUNT -gt 0 ]; then
        echo "  ✓ Bundled ${BUNDLED_COUNT} GStreamer plugins"
    else
        echo "  ⚠ No GStreamer plugins found to bundle"
        echo "    Screenshot capture will require system GStreamer installation"
    fi
else
    echo "  ⚠ GStreamer plugin directory not found"
    echo "    Screenshot capture will require system GStreamer installation"
fi

# Bundle GStreamer core libraries
GST_LIB_DIRS=(
    "/usr/lib/x86_64-linux-gnu"
    "/usr/lib64"
    "/usr/lib"
)

GST_LIB_DIR=""
for dir in "${GST_LIB_DIRS[@]}"; do
    if [ -f "$dir/libgstreamer-1.0.so.0" ]; then
        GST_LIB_DIR="$dir"
        break
    fi
done

if [ -n "$GST_LIB_DIR" ]; then
    mkdir -p "${APPDIR}/usr/lib"
    
    # Copy GStreamer core libraries
    cp -P "${GST_LIB_DIR}"/libgstreamer-1.0.so* "${APPDIR}/usr/lib/" 2>/dev/null || true
    cp -P "${GST_LIB_DIR}"/libgstbase-1.0.so* "${APPDIR}/usr/lib/" 2>/dev/null || true
    cp -P "${GST_LIB_DIR}"/libgstvideo-1.0.so* "${APPDIR}/usr/lib/" 2>/dev/null || true
    cp -P "${GST_LIB_DIR}"/libgstapp-1.0.so* "${APPDIR}/usr/lib/" 2>/dev/null || true
    
    echo "  ✓ Bundled GStreamer core libraries"
fi

echo ""
```

## Where to Insert

In `build.sh`, find this section:

```bash
if [ -f "appimage/timetracker.png" ]; then
    cp appimage/timetracker.png "${APPDIR}/timetracker.png"
    cp appimage/timetracker.png "${APPDIR}/usr/share/icons/hicolor/256x256/apps/timetracker.png"
else
    echo "  [WARN] No icon found — AppImage will use the default icon"
fi
```

Add the GStreamer bundling section **right after** that block (before the appimagetool section).

## Benefits

1. **Reduces user steps** - One less package to install
2. **Consistent version** - Bundled plugins always match
3. **Fallback safety** - System plugins used if bundled ones fail
4. **Small size** - Only ~15-20MB added to AppImage

## Testing

After building with this change:

```bash
# Build AppImage
./build.sh

# Extract and verify plugins bundled
./dist/TimeTracker-*.AppImage --appimage-extract
ls -lh squashfs-root/usr/lib/gstreamer-1.0/

# Should see:
# libgstpipewiresrc.so
# libgstvideoconvert.so
# libgstpngenc.so
# etc.
```

## Note

This bundles the **plugins** but users still need:
- PipeWire (system service)
- xdg-desktop-portal (system service)
- Wireplumber (system service)

Those cannot be bundled - they must run as system services with D-Bus registration.
