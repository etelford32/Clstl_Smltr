# Deployment Guide - Rust Star Renderer

This guide covers deploying the Rust WASM star renderer to various hosting platforms.

## Quick Deploy to Vercel (Recommended)

### Prerequisites
- [Vercel account](https://vercel.com) (free tier works great)
- [Vercel CLI](https://vercel.com/docs/cli) installed: `npm i -g vercel`

### Automated Deployment

1. **From the `rust/` directory:**
   ```bash
   # Login to Vercel (first time only)
   vercel login

   # Deploy
   vercel
   ```

2. **Follow the prompts:**
   - Link to existing project or create new
   - Accept default settings
   - Wait for build (first time takes ~5-10 minutes)

3. **Get your live URL:**
   ```
   ✅ Production: https://your-project.vercel.app
   ```

### Manual Deployment

If the automated build doesn't work yet (due to WASM dependency issues):

1. **Build locally:**
   ```bash
   ./build_wasm.sh
   ```

2. **Deploy the `www/` folder:**
   ```bash
   cd www
   vercel --prod
   ```

Your app will be live instantly!

## Deploy to GitHub Pages

### Option 1: GitHub Actions (Automated)

1. **Create `.github/workflows/deploy-rust-wasm.yml`:**
   ```yaml
   name: Deploy Rust WASM

   on:
     push:
       branches: [ main ]
       paths:
         - 'rust/**'

   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v3

         - name: Install Rust
           uses: actions-rs/toolchain@v1
           with:
             toolchain: stable
             target: wasm32-unknown-unknown

         - name: Install wasm-bindgen
           run: cargo install wasm-bindgen-cli

         - name: Build WASM
           run: |
             cd rust
             ./build_wasm.sh

         - name: Deploy to GitHub Pages
           uses: peaceiris/actions-gh-pages@v3
           with:
             github_token: ${{ secrets.GITHUB_TOKEN }}
             publish_dir: ./rust/www
             destination_dir: rust-renderer
   ```

2. **Enable GitHub Pages:**
   - Go to repo Settings → Pages
   - Source: `gh-pages` branch
   - Your app: `https://yourusername.github.io/repo-name/rust-renderer/`

### Option 2: Manual Deploy

```bash
# Build
./build_wasm.sh

# Copy to gh-pages branch
git checkout gh-pages
cp -r www/* rust-renderer/
git add rust-renderer/
git commit -m "Update Rust renderer"
git push
```

## Deploy to Netlify

### Drag & Drop (Easiest)

1. Build locally: `./build_wasm.sh`
2. Go to [Netlify Drop](https://app.netlify.com/drop)
3. Drag the `www/` folder
4. Done! Get your URL: `https://random-name.netlify.app`

### Netlify CLI

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Build
./build_wasm.sh

# Deploy
cd www
netlify deploy --prod
```

### netlify.toml Configuration

Create `netlify.toml` in `rust/`:

```toml
[build]
  command = "./build_wasm.sh"
  publish = "www"

[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Embedder-Policy = "require-corp"
    Cross-Origin-Opener-Policy = "same-origin"

[[headers]]
  for = "/*.wasm"
  [headers.values]
    Content-Type = "application/wasm"
```

## Deploy to Cloudflare Pages

```bash
# Install Wrangler
npm install -g wrangler

# Build
./build_wasm.sh

# Deploy
cd www
wrangler pages publish . --project-name=star-renderer
```

Your app: `https://star-renderer.pages.dev`

## Custom Domain

All platforms support custom domains:

- **Vercel**: Project Settings → Domains → Add
- **Netlify**: Site Settings → Domain Management → Add custom domain
- **GitHub Pages**: Settings → Pages → Custom domain
- **Cloudflare**: Workers & Pages → Custom domains

## Performance Tips

### 1. Enable Compression

Most platforms auto-compress, but verify:
- Vercel: ✅ Automatic
- Netlify: ✅ Automatic
- GitHub Pages: ✅ Automatic (via CDN)
- Cloudflare: ✅ Automatic

### 2. CDN Caching

Set cache headers in `vercel.json` or platform config:

```json
{
  "headers": [
    {
      "source": "/(.*\\.wasm|.*\\.js)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ]
}
```

### 3. Optimize Build

For smallest bundle:

```bash
# Use release profile (already in Cargo.toml)
cargo build --release --target wasm32-unknown-unknown

# Optional: Use wasm-opt (install from binaryen)
wasm-opt -Oz -o www/star_renderer_bg_opt.wasm www/star_renderer_bg.wasm
mv www/star_renderer_bg_opt.wasm www/star_renderer_bg.wasm
```

## Monitoring & Analytics

### Vercel Analytics

```bash
# Install
npm i @vercel/analytics

# Add to index.html (optional)
```

### Google Analytics

Add to `www/index.html` before `</head>`:

```html
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

## Troubleshooting

### Build Fails on Platform

**Solution**: Build locally and deploy `www/` folder manually:

```bash
./build_wasm.sh
vercel www --prod  # or netlify deploy --prod, etc.
```

### WASM File Not Loading

Check browser console. Common fixes:

1. **MIME Type**: Ensure `.wasm` served as `application/wasm`
2. **CORS**: Add headers (see vercel.json)
3. **File Size**: Check network tab - should be 2-4 MB

### getrandom Error

Current known issue (see WASM_STATUS.md). Workarounds:

1. Use pre-built `www/` folder from successful local build
2. Wait for Bevy 0.13+ update
3. Use alternative RNG (fastrand - already implemented)

## Cost

All platforms have generous free tiers:

| Platform | Free Tier | Bandwidth | Build Minutes |
|----------|-----------|-----------|---------------|
| Vercel | ✅ | 100 GB/month | 6000 min/month |
| Netlify | ✅ | 100 GB/month | 300 min/month |
| GitHub Pages | ✅ | 100 GB/month | Unlimited |
| Cloudflare | ✅ | Unlimited | 500 builds/month |

Perfect for personal projects! 🚀

## Next Steps

1. Deploy using method above
2. Share your live URL!
3. Consider adding:
   - Custom domain
   - Analytics
   - Social preview meta tags
   - Loading optimizations

## Need Help?

- Vercel Docs: https://vercel.com/docs
- Netlify Docs: https://docs.netlify.com
- GitHub Pages: https://pages.github.com
- Cloudflare Pages: https://developers.cloudflare.com/pages

Happy deploying! ✨
