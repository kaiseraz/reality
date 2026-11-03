# Base image for a bot's own computer: an open-source sandbox desktop (upstream in README) plus the
# engineering tools that make work visible — FreeCAD and KiCad on the X desktop, and
# CadQuery on the system Python the sandbox runs. Without this layer every fresh
# computer re-installs ~1.5 GB of CAD packages through the gateway before a demo can
# start (see "warm computers" in docs). Build:
#   docker build -t reality-computer:dev sandbox/computer
# and set COMPUTER_IMAGE=reality-computer:dev.
FROM ghcr.io/agent-infra/sandbox:1.11.0

USER root

# FreeCAD for STEP assemblies, KiCad for boards and schematics, pip for CadQuery.
# --no-install-recommends keeps the extra desktops and docs out of the layer.
# Ubuntu 22.04 ships KiCad 6.0, which cannot open the KiCad 8 boards the lab writes (and its
# first start asks to configure a settings path). KiCad 8 comes from the project's own PPA.
# That PPA brings newer OpenCASCADE libraries than the 0.19 FreeCAD of Ubuntu can use, so
# FreeCAD 0.21 comes from its maintainers' PPA; the two install together.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       software-properties-common ca-certificates gnupg \
    && add-apt-repository -y ppa:kicad/kicad-8.0-releases \
    && add-apt-repository -y ppa:freecad-maintainers/freecad-stable \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       freecad \
       kicad \
       python3-pip \
    && rm -rf /var/lib/apt/lists/*

# KiCad asks which settings to start with on its very first launch, which would sit in front
# of every board a bot opens. A settings folder in the skeleton home skips that.
RUN mkdir -p /etc/skel/.config/kicad/8.0 \
    && printf '{"meta":{"filename":"kicad_common.json","version":3}}' > /etc/skel/.config/kicad/8.0/kicad_common.json

# A way to press keys in a window: after a board opens, Alt+3 brings up KiCad's 3D viewer,
# where the lab's part models show. Its own layer, so the big one above stays cached.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xdotool \
    && rm -rf /var/lib/apt/lists/*

# Eyes that can measure: a bot reads the screen with OCR to get the exact position of a button,
# since judging pixels from a picture alone misses small targets.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tesseract-ocr scrot imagemagick \
    && rm -rf /var/lib/apt/lists/*

# CadQuery on the interpreter the sandbox uses, wheels only: the OCP kernel is a
# binary wheel, nothing has to compile.
RUN python3 -m pip install --no-cache-dir --only-binary=:all: cadquery \
    && python3 -c "import cadquery; print('cadquery', cadquery.__version__)"

# STEP assemblies keep their part names only if FreeCAD does not merge them into one
# compound on import. The preference file turns that off; it is seeded into every new
# desktop home (the sandbox entrypoint runs `useradd --create-home`, which copies
# /etc/skel) and copied again on start for existing homes.
COPY freecad-user.cfg /opt/reality/freecad-user.cfg
# The same for KiCad: its settings and empty library tables (the boards the lab writes carry their
# own footprints), copied into the home at every start since the home is not built from /etc/skel.
# Without them KiCad asks how to configure itself, and the PCB editor asks for a library table,
# in front of every board a bot opens.
COPY kicad /opt/reality/kicad
COPY freecad-user.cfg /etc/skel/.FreeCAD/user.cfg
COPY freecad-user.cfg /etc/skel/.config/FreeCAD/user.cfg

# The browser searches with DuckDuckGo, which every computer may reach: Google is not allowed,
# so a search typed into the address bar used to end on an error page.
COPY browser-search.json /etc/chromium/policies/managed/reality-search.json

# The sandbox's own entrypoint (/opt/gem/run.sh) creates the `gem` desktop user at
# container start; do not switch USER here or the image cannot start (the user does
# not exist in /etc/passwd yet). Tools stay readable for it under /usr.
