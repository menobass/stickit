-- Stickit: floating, see-through sticky notes. The app draws its own transparency,
-- so opt out of Omarchy's default opacity to avoid double-dimming.
o.window("^stickit$", { float = true, tag = "-default-opacity" })
