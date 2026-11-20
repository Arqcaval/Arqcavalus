"""Bundle the Vite build into one HTML file for claude.ai hosting."""
import glob, pathlib, sys
root = pathlib.Path(__file__).parent
js = pathlib.Path(glob.glob(str(root / "dist/assets/*.js"))[0]).read_text()
css = pathlib.Path(glob.glob(str(root / "dist/assets/*.css"))[0]).read_text()
assert "</script" not in js.lower(), "bundle contains a closing script tag"
html = f"""<title>OSSA Image Synth</title>
<meta name="description" content="Document-grounded architectural visualization workstation">
<style>{css}</style>
<div id="root"></div>
<script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<script type="module">{js}</script>
"""
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / "image-synth.html")
out.write_text(html)
print(out, len(html) // 1024, "KB")
