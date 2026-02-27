const { chromium } = require('playwright');
const fs = require('fs');
const https = require('https');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://www.youtube.com/watch?v=62Rfe1w9NBc', { waitUntil: 'networkidle', timeout: 30000 });

  // Get caption URL and cookies from browser context
  var captionUrl = await page.evaluate(function() {
    if (typeof ytInitialPlayerResponse !== 'undefined') {
      var captions = ytInitialPlayerResponse.captions;
      if (captions && captions.playerCaptionsTracklistRenderer) {
        var tracks = captions.playerCaptionsTracklistRenderer.captionTracks;
        if (tracks && tracks.length > 0) {
          return tracks[0].baseUrl;
        }
      }
    }
    return null;
  });

  if (!captionUrl) {
    console.log('No caption URL found');
    await browser.close();
    return;
  }

  console.log('Caption URL:', captionUrl.slice(0, 80) + '...');

  // Get cookies from browser
  var cookies = await context.cookies();
  var cookieStr = cookies.map(function(c) { return c.name + '=' + c.value; }).join('; ');

  // Fetch from Node.js with browser cookies
  var data = await new Promise(function(resolve, reject) {
    var opts = {
      headers: {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://www.youtube.com/watch?v=62Rfe1w9NBc'
      }
    };
    https.get(captionUrl, opts, function(res) {
      var body = '';
      res.on('data', function(c) { body += c; });
      res.on('end', function() { resolve(body); });
    }).on('error', reject);
  });

  await browser.close();

  console.log('Response length:', data.length);

  if (data.length > 0) {
    fs.writeFileSync('/tmp/captions-raw.xml', data);
    var segments = [];
    var re = /<text[^>]*>([^<]*)<\/text>/g;
    var m;
    while ((m = re.exec(data)) !== null) {
      var clean = m[1]
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
      if (clean) segments.push(clean);
    }
    var transcript = segments.join(' ');
    fs.writeFileSync('/tmp/pixel-agents-transcript.txt', transcript);
    console.log('Segments:', segments.length);
    console.log('Chars:', transcript.length);
    console.log('---');
    console.log(transcript);
  }
})();
