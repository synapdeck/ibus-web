# Meson reads cross files in order and later values win, so this one only
# carries what differs from nixpkgs' generated cross file.
mesonFlagsArray+=("--cross-file=@crossFile@")
