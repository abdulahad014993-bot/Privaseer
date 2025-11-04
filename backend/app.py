from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
from bs4 import BeautifulSoup
from readability import Document
import re

app = Flask(__name__)
CORS(app)

# ----- v1 rule-based categories -----
CATEGORY_PATTERNS = {
    "collection": [
        r"\bcollect(s|ed|ing)?\b",
        r"\bgather(s|ed|ing)?\b",
        r"\binformation we (?:collect|receive)\b",
        r"\bdata (?:we|that we) collect\b",
    ],
    "sharing": [
        r"\bshare(s|d|ing)?\b",
        r"\bdisclose(s|d|ing)?\b",
        r"\bthird[- ]part(?:y|ies)\b",
        r"\baffiliates?\b",
    ],
    "selling": [
        r"\bsell(s|ing|sold)?\b",
        r"\bsale of (?:your )?data\b",
        r"\bdo not sell\b",   # negation handled as evidence too (you can split later)
    ],
    "retention": [
        r"\bretain(s|ed|ing)?\b",
        r"\bretention\b",
        r"\bhow long\b.*\b(keep|store)\b",
        r"\bstore(d|s|ing)?\b",
    ],
    "transfers": [
        r"\btransfer(s|red|ring)?\b",
        r"\bprocess(ed|ing)? in\b.*\b(country|region)\b",
        r"\bcross[- ]border\b",
        r"\binternational\b.*\btransfer\b",
    ],
    "rights_deletion_access": [
        r"\bdelete(s|d|ing)?\b",
        r"\bdeletion request(s)?\b",
        r"\baccess your data\b",
        r"\bcorrection\b|\brectification\b",
        r"\bportability\b",
        r"\bright(s)? under\b",
        r"\bCCPA\b|\bGDPR\b|\bCPRA\b",
    ],
    "consent_optout": [
        r"\bconsent\b",
        r"\bopt[- ]out\b|\bopt[- ]in\b",
        r"\bchoices?\b.*\bprivacy\b",
        r"\bmanage your preferences\b",
        r"\bmarketing communications\b.*\bunsubscribe\b",
    ],
}

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")

def extract_text_from_url(url: str) -> str:
    resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    doc = Document(resp.text)
    html = doc.summary()
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = soup.get_text(separator=" ", strip=True)
    return re.sub(r"\s+", " ", text)

def analyze_text(text: str):
    sentences = SENTENCE_SPLIT.split(text)
    results = {k: {"count": 0, "evidence": []} for k in CATEGORY_PATTERNS}
    for cat, patterns in CATEGORY_PATTERNS.items():
        compiled = [re.compile(p, flags=re.IGNORECASE) for p in patterns]
        for i, sent in enumerate(sentences):
            if any(p.search(sent) for p in compiled):
                results[cat]["count"] += 1
                if len(results[cat]["evidence"]) < 5:
                    results[cat]["evidence"].append({"i": i, "text": sent.strip()})
    max_count = max((v["count"] for v in results.values()), default=0)
    for cat, data in results.items():
        data["score"] = (data["count"] / max_count) if max_count else 0.0
    return results

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/analyze/text")
def analyze_text_endpoint():
    body = request.get_json(force=True) or {}
    text = body.get("text", "").strip()
    if not text:
        return jsonify({"error": "Provide 'text'"}), 400
    return jsonify({"results": analyze_text(text)})

@app.post("/analyze/url")
def analyze_url_endpoint():
    body = request.get_json(force=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "Provide 'url'"}), 400
    try:
        text = extract_text_from_url(url)
    except Exception as e:
        return jsonify({"error": f"Failed to fetch/parse: {e}"}), 400
    return jsonify({"results": analyze_text(text), "meta": {"char_len": len(text)}})

if __name__ == "__main__":
    app.run(debug=True, port=8000)
