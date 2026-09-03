"""
Generate the PWA icon set.

A ONE-OFF ASSET GENERATOR, NOT A BUILD STEP
The outputs are committed. This is here so the icons have provenance -- so that
"why is the orbit at 28 degrees" has an answer, and so a change is a diff to code
rather than a binary someone replaced by hand. It needs Python and Pillow, neither of
which is a dependency of the app, CI, or the build. Run it only when the mark changes:

    python apps/web/scripts/generate-icons.py

THE MARK
An inclined orbit crossing in front of the limb of the Earth, with the satellite at
the ascending node. 28.5 degrees is the inclination of the ISS -- the orbit most
people picture when they think of something passing overhead, and the one this
product is most often opened to look at.

MASKABLE IS A SEPARATE FILE, NOT THE SAME ONE RELABELLED
Android crops a maskable icon to whatever shape the launcher uses, and only the inner
80% circle is guaranteed to survive. Declaring the standard icon as maskable is the
usual mistake: it renders correctly in the manifest checker and gets its edges cut off
on a real phone. The maskable variant draws the same mark smaller, inside that safe
zone, on a full-bleed background.
"""

from PIL import Image, ImageDraw

BACKGROUND = (7, 11, 20, 255)      # --ow-bg
EARTH = (18, 30, 48, 255)
LIMB = (53, 200, 245, 90)          # --ow-accent, dimmed: a rim, not a ring
ORBIT = (53, 200, 245, 255)        # --ow-accent
SATELLITE = (232, 238, 248, 255)   # --ow-text

# Supersampled, then reduced. Pillow has no antialiasing on shape fills, and at 192px
# an aliased orbit line looks like a staircase.
SCALE = 8
INCLINATION = 28.5


def draw_mark(size: int, inset: float) -> Image.Image:
    """
    One icon. `inset` is the fraction of the canvas the mark leaves empty at the edge:
    0.08 for a normal icon, 0.20 for a maskable one whose edges may be cropped away.
    """
    px = size * SCALE
    image = Image.new("RGBA", (px, px), BACKGROUND)

    art = px * (1 - 2 * inset)
    centre = px / 2
    earth_radius = art * 0.30
    orbit_radius = art * 0.47
    # A circle seen at an angle is an ellipse; this is the projected semi-minor axis.
    orbit_minor = orbit_radius * 0.42
    stroke = max(1, int(art * 0.035))

    draw = ImageDraw.Draw(image)
    draw.ellipse(
        [centre - earth_radius, centre - earth_radius,
         centre + earth_radius, centre + earth_radius],
        fill=EARTH,
        outline=LIMB,
        width=stroke,
    )

    # The orbit is drawn on its own layer so it can be rotated about the centre. It is
    # a full ellipse: the half behind the Earth is hidden by redrawing the disc over
    # it, which is what makes the crossing read as depth rather than as a flat ring.
    orbit_layer = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(orbit_layer).ellipse(
        [centre - orbit_radius, centre - orbit_minor,
         centre + orbit_radius, centre + orbit_minor],
        outline=ORBIT,
        width=stroke,
    )
    orbit_layer = orbit_layer.rotate(INCLINATION, resample=Image.BICUBIC, center=(centre, centre))

    behind = orbit_layer.copy()
    image.alpha_composite(behind)
    draw.ellipse(
        [centre - earth_radius, centre - earth_radius,
         centre + earth_radius, centre + earth_radius],
        fill=EARTH,
        outline=LIMB,
        width=stroke,
    )

    # Only the near half of the orbit survives in front of the Earth.
    #
    # The dividing line is the orbit's OWN major axis, not the horizontal. Cutting on
    # the horizontal is the obvious thing and it is wrong by exactly the inclination:
    # the cut crosses the ellipse stroke at an angle and leaves a notch at the left
    # crossing, which at icon sizes reads as a rendering fault rather than as depth.
    half = Image.new("L", (px, px), 0)
    ImageDraw.Draw(half).rectangle([0, centre, px, px], fill=255)
    half = half.rotate(INCLINATION, resample=Image.BICUBIC, center=(centre, centre))

    front = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    front.paste(orbit_layer, mask=half)
    image.alpha_composite(front)

    # The satellite, on the orbit at the right-hand crossing.
    import math
    angle = math.radians(INCLINATION)
    sx = centre + orbit_radius * math.cos(angle)
    sy = centre - orbit_radius * math.sin(angle)
    dot = stroke * 1.6
    ImageDraw.Draw(image).ellipse([sx - dot, sy - dot, sx + dot, sy + dot], fill=SATELLITE)

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = "apps/web/public/icons"
    for size in (192, 512):
        draw_mark(size, inset=0.08).save(f"{out}/icon-{size}.png")
    draw_mark(512, inset=0.20).save(f"{out}/icon-maskable-512.png")
    # iOS ignores the manifest and takes this one, at this exact name and size.
    draw_mark(180, inset=0.08).save(f"{out}/apple-touch-icon.png")
    print("wrote icon-192, icon-512, icon-maskable-512, apple-touch-icon")


if __name__ == "__main__":
    main()
