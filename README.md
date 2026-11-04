# Lexi - Reading Helper & Accessibility Assistant

> A web-based reading assistant optimized specifically for individuals with dyslexia, visual fatigue, and reading difficulties.

## 🔗 Live Demo & Links
* **Live Application:** [View Live Website Here](https://lexi-reading-helper.netlify.app/) *(https://github.com/NDEHFOJE-star/TEAM-Lexi)*
* **Course:** ICT 2140 - Introduction to Software Engineering

---

## 📖 About the Project
Standard digital text formats often lack customization for readability, making reading tedious or inaccessible for users with dyslexia. **Lexi** is a client-side web application designed to bridge this gap. It allows users to instantly paste text, scan physical documents via camera, or upload PDFs, and read or listen to them using personalized visual configurations.

## ✨ Core Features
* **Dyslexia-Optimized Typography:** Includes support for specialized fonts (such as OpenDyslexic) and adjustable letter, word, and line spacing to reduce visual crowding.
* **Optical Character Recognition (OCR):** Built using **Tesseract.js** to extract and digitize text from uploaded images or camera captures instantly in the browser.
* **Document Parsing:** Integrated **PDF.js** support to parse and render text directly from uploaded PDF documents.
* **Text-to-Speech (TTS):** Powered by the browser's native Speech Synthesis API, allowing users to listen to passages with adjustable playback controls (Play, Pause, Stop, and speed adjustments).
* **High-Contrast Themes:** Custom color palettes (Cream, Light Blue, High Contrast) designed to minimize glare and visual fatigue.

## 🛠️ Technology Stack
* **Frontend:** HTML5, CSS3, Modern JavaScript (ES6+)
* **Processing Libraries:** Tesseract.js (OCR), PDF.js (Document Parsing)
* **Version Control & Hosting:** Git, GitHub, and Web Deployment Platforms

---

## 📂 Repository Structure
```text
├── lexi/
│   ├── index.html    # Main single-page application interface
│   ├── style.css     # Styling, layout, and accessibility themes
│   ├── script.js     # Application logic, OCR, and TTS handlers
│   └── server.js     # Separate local development backend
├── netlify.toml      # Publishes the lexi directory at the site root
└── README.md         # Project documentation
```

## Netlify Deployment

Netlify reads the root `netlify.toml` and publishes `lexi`, which contains
`index.html`, `style.css`, and `script.js`. This static frontend does not require
a build command. After deployment, open https://lexi-reading-helper.netlify.app/.
Publishing the repository root instead causes a 404 at `/`, because there is no
`index.html` in that directory.

Passage storage currently uses a separate development backend at
`http://localhost:3000`. Netlify static hosting does not run `lexi/server.js`, so
loading the deployed frontend does not enable passage saving or retrieval. That
backend requires a separate migration to a hosted API and persistent storage.
