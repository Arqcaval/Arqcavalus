"""Generates the SAMPLE documents in examples/myers-park-halfway-house.

The finish codes/products come from the OSSA reference list. Room names, locations, equipment items and
the render are FICTIONAL SAMPLE DATA for demonstration and testing only — replace them with the real
project documents.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "examples" / "myers-park-halfway-house"
OUT.mkdir(parents=True, exist_ok=True)

(OUT / "MPCC-HH_Finish_Schedule_SAMPLE.csv").write_text("""Code,Manufacturer,Product,Finish,Location,Drawing
P1,Sherwin-Williams,SW 7005 Pure White,Eggshell,Walls above wainscot - Servery,A6.01
P2,Sherwin-Williams,SW 6254 Lazy Gray,Eggshell,Accent wall - Seating,A6.01
P3,Sherwin-Williams,SW 6256 Serious Gray,Semi-gloss,Door frames,A6.02
P4,Sherwin-Williams,SW 9177 Salty Dog,Eggshell,Bar front accent,A6.02
PL2,Formica,09312 Planked Urban Oak,Natural Grain,Bar die wall and cabinet faces,A6.02
SS1,Formica,Everform 620 Tumbled Harvest,Matte,Bar countertop,A6.02
SS2,Formica,Everform 623 Fossilized Lava,Matte,Bar backsplash,A6.02
WCP1,Armstrong,"WoodWorks Linear Veneered, Plain Slice Cherry",Plain Slice,Ceiling - Servery,A3.01
""")

(OUT / "MPCC-HH_Equipment_Schedule_SAMPLE.csv").write_text("""Item No,Qty,Description,Manufacturer,Model,Dimensions,Electrical,Location
FS-01,1,Undercounter Refrigerator,True,TUC-27-HC,27 x 30 x 29.75 in,115V,Servery
FS-02,1,Ice Machine with Bin,Hoshizaki,KM-515MAJ,30 x 24 x 38 in,115V,Servery
FS-03,1,Countertop Ventless Oven,Merrychef,eikon e2s,14 x 23 x 21 in,208V,Servery
FS-04,1,Glass Door Merchandiser,Beverage-Air,MT10-1,24 x 26 x 72 in,115V,Bar
FS-05,1,Hand Sink,Eagle,HSA-10-FA,13.5 x 9.75 x 13 in,,Servery
""")

(OUT / "MPCC-HH_Project_Description_SAMPLE.txt").write_text("""SAMPLE PROJECT DESCRIPTION (fictional details for demonstration)
Project: Myers Park Country Club - Halfway House
Project Number: MPCC-HH
Client: Myers Park Country Club
Architect: OSSA Studio
Scope: Interior renovation of the golf course halfway house servery and bar.
Rooms: Servery 101, Bar 102, Seating 103, Storage 104
Sheets:
A1.01 FLOOR PLAN
A3.01 REFLECTED CEILING PLAN
A6.01 INTERIOR ELEVATIONS
A6.02 BAR ELEVATIONS AND SECTIONS
Existing structure to remain. Do not alter the window openings.
""")

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas(str(OUT / "MPCC-HH_Equipment_Plan_SAMPLE.pdf"), pagesize=letter)
c.setFont("Helvetica-Bold", 14)
c.drawString(60, 740, "FOOD SERVICE EQUIPMENT PLAN - SAMPLE (fictional)")
c.setFont("Helvetica", 10)
c.drawString(60, 722, "Project: Myers Park Country Club - Halfway House   Sheet FS1.01")
c.rect(60, 300, 480, 380)
for x, y, tag in [(90, 640, "FS-01"), (190, 640, "FS-02"), (290, 640, "FS-03"), (420, 420, "FS-04")]:
    c.rect(x, y - 20, 70, 30)
    c.drawString(x + 12, y - 8, tag)
c.drawString(70, 310, "SERVERY 101                       BAR 102")
c.save()

# Synthetic "render" (NOT an Enscape render): flat-shaded bar elevation used for tests and demos.
W, H = 1600, 1000
im = Image.new("RGB", (W, H), (238, 236, 230))
d = ImageDraw.Draw(im)
d.rectangle([0, 0, W, 140], fill=(150, 92, 62))            # WCP1 cherry ceiling
for x in range(0, W, 40):
    d.line([x, 0, x, 140], fill=(120, 72, 48), width=3)
d.rectangle([0, 140, W, 560], fill=(244, 244, 240))         # P1 wall
d.rectangle([980, 180, 1500, 480], fill=(205, 222, 235))    # window
d.rectangle([980, 180, 1500, 480], outline=(40, 40, 40), width=8)
d.rectangle([0, 560, W, 600], fill=(70, 70, 72))            # SS2 backsplash
d.rectangle([0, 600, W, 640], fill=(196, 170, 128))         # SS1 counter
d.rectangle([0, 640, W, 900], fill=(160, 132, 96))          # PL2 cabinet faces
for x in range(0, W, 320):
    d.line([x, 640, x, 900], fill=(15, 15, 15), width=4)     # slim black separators
d.rectangle([0, 900, W, H], fill=(110, 110, 112))           # floor
d.text((20, 960), "SYNTHETIC TEST IMAGE - not an Enscape render", fill=(255, 255, 255))
im.save(OUT / "render_bar_view_SYNTHETIC.png")

# Mask covering the cabinet faces (edit region) and a protected mask over the backsplash.
m = Image.new("L", (W, H), 0)
ImageDraw.Draw(m).rectangle([0, 640, W, 900], fill=255)
m.save(OUT / "mask_cabinet_faces_edit.png")
p = Image.new("L", (W, H), 0)
ImageDraw.Draw(p).rectangle([0, 560, W, 600], fill=255)
p.save(OUT / "mask_backsplash_protected.png")
print("written", OUT)
