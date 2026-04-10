require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8071;
const COOKIES_PATH = path.join(__dirname, 'cookies.json');
const CHROMIUM_PATH = '/usr/bin/chromium-browser';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MIN_REQUEST_DELAY = 3000;

let browser = null;
let lastRequestTime = 0;

// ─── Browser Management ─────────────────────────────────────────────

async function launchBrowser() {
  if (browser && browser.connected) return browser;
  browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,800',
      '--lang=en-US,en'
    ]
  });
  browser.on('disconnected', () => { browser = null; });
  console.log(`[${ts()}] Browser launched`);
  return browser;
}

async function getPage() {
  const b = await launchBrowser();
  const page = await b.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1280, height: 800 });

  // Load cookies
  if (fs.existsSync(COOKIES_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    await page.setCookie(...cookies);
  }
  return page;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

function enforceRateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_DELAY) {
    return MIN_REQUEST_DELAY - elapsed;
  }
  return 0;
}

function normalizeProfileUrl(input) {
  let url = input.trim().replace(/\/+$/, '');
  if (!url.includes('linkedin.com')) {
    url = `https://www.linkedin.com/in/${url}`;
  }
  if (!url.startsWith('http')) {
    url = `https://${url}`;
  }
  return url;
}

function normalizeCompanyUrl(input) {
  let url = input.trim().replace(/\/+$/, '');
  if (!url.includes('linkedin.com')) {
    url = `https://www.linkedin.com/company/${url}`;
  }
  if (!url.startsWith('http')) {
    url = `https://${url}`;
  }
  // Ensure we go to /about/ page
  if (!url.endsWith('/about') && !url.endsWith('/about/')) {
    url = url + '/about/';
  }
  return url;
}

async function scrollPage(page) {
  for (let i = 0; i < 8; i++) {
    await page.evaluate((step) => window.scrollBy(0, 600), i);
    await delay(400);
  }
  await delay(2000);
}

async function clickShowMoreButtons(page) {
  try {
    const buttons = await page.$$([
      'button.inline-show-more-text__button',
      'button[aria-label*="Show more"]',
      'button[aria-label*="show more"]',
      'button[aria-label*="See more"]',
      'button[aria-label*="see more"]',
      'button.pv-profile-section__see-more-inline',
      'button.pv-skill-categories-section__chevron-icon'
    ].join(', '));

    const limit = Math.min(buttons.length, 5);
    for (let i = 0; i < limit; i++) {
      try {
        await buttons[i].click();
        await delay(300);
      } catch (_) { /* button may have gone stale */ }
    }
  } catch (_) { /* no buttons found */ }
  await delay(1000);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isLoginRedirect(url) {
  return url.includes('/login') || url.includes('/authwall');
}

// ─── GET /health ─────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  console.log(`[${ts()}] GET /health`);
  const cookiesLoaded = fs.existsSync(COOKIES_PATH);
  res.json({ status: 'ok', cookiesLoaded });
});

// ─── POST /set-cookie ────────────────────────────────────────────────

app.post('/set-cookie', (req, res) => {
  console.log(`[${ts()}] POST /set-cookie`);
  const { li_at } = req.body || {};

  if (!li_at) {
    return res.status(400).json({ success: false, error: 'Missing li_at in body' });
  }

  const cookies = [
    {
      name: 'li_at',
      value: li_at,
      domain: '.linkedin.com',
      path: '/',
      httpOnly: true,
      secure: true
    }
  ];

  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log(`[${ts()}] Cookie saved to ${COOKIES_PATH}`);
  res.json({ success: true });
});

// ─── POST /login ────────────────────────────────────────────────────

app.post('/login', async (req, res) => {
  console.log(`[${ts()}] POST /login`);
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Missing email or password in body' });
  }

  let page = null;
  try {
    const b = await launchBrowser();
    page = await b.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

    // Fill in credentials
    await page.type('#username', email, { delay: 50 });
    await page.type('#password', password, { delay: 50 });
    await page.click('button[type="submit"]');

    // Wait for navigation after login
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    const currentUrl = page.url();

    // Check for security challenge (CAPTCHA, 2FA, verification)
    if (currentUrl.includes('/checkpoint') || currentUrl.includes('/challenge')) {
      return res.status(403).json({ success: false, error: 'LinkedIn security challenge detected (CAPTCHA or 2FA). Try again later or verify your account.' });
    }

    // Check if still on login page (wrong credentials)
    if (currentUrl.includes('/login')) {
      return res.status(401).json({ success: false, error: 'Login failed. Check your email and password.' });
    }

    // Extract all cookies from the authenticated session
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));

    const hasLiAt = cookies.some(c => c.name === 'li_at');
    console.log(`[${ts()}] Login successful, ${cookies.length} cookies saved (li_at: ${hasLiAt})`);
    res.json({ success: true, cookieCount: cookies.length });

  } catch (err) {
    console.error(`[${ts()}] Login error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
  }
});

// ─── POST /profile ───────────────────────────────────────────────────

app.post('/profile', async (req, res) => {
  console.log(`[${ts()}] POST /profile`);

  if (!fs.existsSync(COOKIES_PATH)) {
    return res.status(401).json({ success: false, error: 'Call POST /set-cookie first' });
  }

  const { linkedin_url } = req.body || {};
  if (!linkedin_url) {
    return res.status(400).json({ success: false, error: 'Missing linkedin_url in body' });
  }

  // Rate limit
  const waitMs = enforceRateLimit();
  if (waitMs > 0) await delay(waitMs);
  lastRequestTime = Date.now();

  const profileUrl = normalizeProfileUrl(linkedin_url);
  console.log(`[${ts()}] Scraping profile: ${profileUrl}`);

  let page = null;
  try {
    page = await getPage();
    await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Check for login redirect
    if (isLoginRedirect(page.url())) {
      return res.status(401).json({ success: false, error: 'Cookie expired' });
    }

    // Wait for main content
    try {
      await page.waitForSelector('main', { timeout: 10000 });
    } catch (_) { /* page might still be usable */ }

    // Scroll to trigger lazy loading
    await scrollPage(page);

    // Click show more buttons
    await clickShowMoreButtons(page);

    // Extract profile data
    const profile = await page.evaluate((originalUrl) => {
      function getText(el) {
        return el ? el.innerText.trim() : '';
      }
      function getSection(id) {
        const anchor = document.querySelector('#' + id);
        return anchor ? anchor.closest('section') : null;
      }
      function limitText(text, max) {
        if (!text) return '';
        return text.length > max ? text.substring(0, max) + '...' : text;
      }

      // ── Name, headline, location ──
      const name = getText(document.querySelector('h1')) || '';
      const headline = getText(document.querySelector('.text-body-medium')) || '';
      const location = getText(document.querySelector('.text-body-small.inline.t-black--light.break-words')) || '';

      // ── Connections ──
      let connections = '';
      const allSpans = document.querySelectorAll('span');
      for (const sp of allSpans) {
        const t = sp.innerText || '';
        if (t.includes('connection') || t.includes('follower')) {
          connections = t.trim();
          break;
        }
      }

      // ── About ──
      let about = '';
      const aboutSection = getSection('about');
      if (aboutSection) {
        const showMore = aboutSection.querySelector('.inline-show-more-text span[aria-hidden="true"]');
        about = showMore ? showMore.innerText.trim() : '';
        if (!about) {
          const fallback = aboutSection.querySelector('.inline-show-more-text');
          about = fallback ? fallback.innerText.trim() : '';
        }
      }
      about = limitText(about, 1000);

      // ── Experience ──
      const experiences = [];
      const expSection = getSection('experience');
      if (expSection) {
        const items = expSection.querySelectorAll(':scope > div > ul > li');
        items.forEach(li => {
          // Check for grouped experiences (multiple roles at same company)
          const nestedItems = li.querySelectorAll(':scope > div > div > ul > li');
          if (nestedItems.length > 0) {
            // Grouped: company is in parent, roles are nested
            const companyEl = li.querySelector('.t-bold span');
            const company = companyEl ? companyEl.innerText.trim() : '';
            nestedItems.forEach(nested => {
              const spans = nested.querySelectorAll('span[aria-hidden="true"]');
              const texts = Array.from(spans).map(s => s.innerText.trim()).filter(Boolean);
              experiences.push({
                title: texts[0] || '',
                company: company,
                dateRange: texts[2] || '',
                duration: texts[3] || '',
                location: texts[4] || '',
                description: limitText(texts.slice(5).join(' '), 1000)
              });
            });
          } else {
            // Single role
            const spans = li.querySelectorAll('span[aria-hidden="true"]');
            const texts = Array.from(spans).map(s => s.innerText.trim()).filter(Boolean);
            experiences.push({
              title: texts[0] || '',
              company: texts[1] || '',
              dateRange: texts[2] || '',
              duration: texts[3] || '',
              location: texts[4] || '',
              description: limitText(texts.slice(5).join(' '), 1000)
            });
          }
        });
      }

      // ── Education ──
      const education = [];
      const eduSection = getSection('education');
      if (eduSection) {
        const items = eduSection.querySelectorAll(':scope > div > ul > li');
        items.forEach(li => {
          const spans = li.querySelectorAll('span[aria-hidden="true"]');
          const texts = Array.from(spans).map(s => s.innerText.trim()).filter(Boolean);
          education.push({
            school: texts[0] || '',
            degree: texts[1] || '',
            dates: texts[2] || '',
            activities: limitText(texts.slice(3).join(' '), 1000)
          });
        });
      }

      // ── Skills ──
      const skills = [];
      const skillsSection = getSection('skills');
      if (skillsSection) {
        const items = skillsSection.querySelectorAll(':scope > div > ul > li');
        items.forEach(li => {
          const nameEl = li.querySelector('.t-bold span') || li.querySelector('span[aria-hidden="true"]');
          const skillName = nameEl ? nameEl.innerText.trim() : '';
          if (!skillName) return;
          // Look for endorsement count
          let endorsements = '';
          const allSpans = li.querySelectorAll('span[aria-hidden="true"]');
          for (const s of allSpans) {
            const t = s.innerText.trim();
            if (t.includes('endorsement') || /^\d+\+?$/.test(t)) {
              endorsements = t.replace(/\s*endorsement.*$/i, '').trim();
              break;
            }
          }
          skills.push({ name: skillName, endorsements });
        });
      }

      // ── Languages ──
      const languages = [];
      const langSection = getSection('languages');
      if (langSection) {
        const items = langSection.querySelectorAll(':scope > div > ul > li');
        items.forEach(li => {
          const spans = li.querySelectorAll('span[aria-hidden="true"]');
          const texts = Array.from(spans).map(s => s.innerText.trim()).filter(Boolean);
          languages.push({
            language: texts[0] || '',
            proficiency: texts[1] || ''
          });
        });
      }

      // ── Certifications ──
      const certifications = [];
      const certSection = getSection('licenses_and_certifications');
      if (certSection) {
        const items = certSection.querySelectorAll(':scope > div > ul > li');
        items.forEach(li => {
          const spans = li.querySelectorAll('span[aria-hidden="true"]');
          const texts = Array.from(spans).map(s => s.innerText.trim()).filter(Boolean);
          certifications.push({
            name: texts[0] || '',
            issuer: texts[1] || '',
            date: texts[2] || ''
          });
        });
      }

      // ── Volunteer ──
      const volunteer = [];
      const volSection = getSection('volunteering_experience');
      if (volSection) {
        const items = volSection.querySelectorAll(':scope > div > ul > li');
        items.forEach(li => {
          const spans = li.querySelectorAll('span[aria-hidden="true"]');
          const texts = Array.from(spans).map(s => s.innerText.trim()).filter(Boolean);
          volunteer.push({
            role: texts[0] || '',
            organization: texts[1] || ''
          });
        });
      }

      // ── Recommendations count ──
      let recommendations = 0;
      const recSection = getSection('recommendations');
      if (recSection) {
        const tabPanels = recSection.querySelectorAll('[role="tabpanel"]');
        const listItems = recSection.querySelectorAll(':scope > div > ul > li');
        recommendations = Math.max(tabPanels.length, listItems.length);
        // Try to find count from tab buttons
        const tabs = recSection.querySelectorAll('button[role="tab"]');
        for (const tab of tabs) {
          const match = tab.innerText.match(/(\d+)/);
          if (match) {
            recommendations = parseInt(match[1], 10);
            break;
          }
        }
      }

      return {
        name,
        headline,
        location,
        about,
        profileUrl: originalUrl,
        experiences,
        education,
        skills,
        languages,
        certifications,
        volunteer,
        recommendations,
        connections
      };
    }, profileUrl);

    // Check if we got a valid profile
    if (!profile.name) {
      return res.status(404).json({ success: false, error: 'Profile not found or page could not be parsed' });
    }

    console.log(`[${ts()}] Scraped profile: ${profile.name}`);
    res.json({ success: true, profile });

  } catch (err) {
    console.error(`[${ts()}] Profile scrape error:`, err.message);
    if (err.message.includes('ERR_TOO_MANY_REDIRECTS')) {
      return res.status(401).json({ success: false, error: 'Too many redirects — cookie is invalid or expired. Use POST /login to re-authenticate from this server.' });
    }
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
  }
});

// ─── POST /company ───────────────────────────────────────────────────

app.post('/company', async (req, res) => {
  console.log(`[${ts()}] POST /company`);

  if (!fs.existsSync(COOKIES_PATH)) {
    return res.status(401).json({ success: false, error: 'Call POST /set-cookie first' });
  }

  const { linkedin_url } = req.body || {};
  if (!linkedin_url) {
    return res.status(400).json({ success: false, error: 'Missing linkedin_url in body' });
  }

  // Rate limit
  const waitMs = enforceRateLimit();
  if (waitMs > 0) await delay(waitMs);
  lastRequestTime = Date.now();

  const companyUrl = normalizeCompanyUrl(linkedin_url);
  console.log(`[${ts()}] Scraping company: ${companyUrl}`);

  let page = null;
  try {
    page = await getPage();
    await page.goto(companyUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Check for login redirect
    if (isLoginRedirect(page.url())) {
      return res.status(401).json({ success: false, error: 'Cookie expired' });
    }

    // Wait for main content
    try {
      await page.waitForSelector('main', { timeout: 10000 });
    } catch (_) {}

    // Scroll down
    await scrollPage(page);

    // Extract company data
    const company = await page.evaluate((originalUrl) => {
      function getText(el) {
        return el ? el.innerText.trim() : '';
      }

      // ── Company name ──
      const name = getText(document.querySelector('h1'))
        || getText(document.querySelector('.org-top-card-summary__title'));

      // ── Tagline ──
      const tagline = getText(document.querySelector('.org-top-card-summary__tagline'))
        || getText(document.querySelector('p.break-words'));

      // ── About text ──
      let about = '';
      const aboutP = document.querySelector('p.break-words.org-about-us-organization-description__text');
      if (aboutP) {
        about = aboutP.innerText.trim();
      } else {
        // Fallback: largest paragraph in the about section
        const paras = document.querySelectorAll('section p');
        let longest = '';
        paras.forEach(p => {
          const t = p.innerText.trim();
          if (t.length > longest.length) longest = t;
        });
        about = longest;
      }

      // ── Structured data from dt/dd pairs ──
      const data = {};
      const dts = document.querySelectorAll('dt');
      dts.forEach(dt => {
        const key = dt.innerText.trim().toLowerCase();
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') {
          data[key] = dd.innerText.trim();
        }
      });

      // Also try div-based definition items (newer layout)
      const defItems = document.querySelectorAll('[data-test-id]');
      defItems.forEach(item => {
        const label = item.querySelector('dt, .org-page-details__definition-term');
        const value = item.querySelector('dd, .org-page-details__definition-text');
        if (label && value) {
          data[label.innerText.trim().toLowerCase()] = value.innerText.trim();
        }
      });

      const website = data['website'] || data['site web'] || '';
      const industry = data['industry'] || data['secteur'] || '';
      const companySize = data['company size'] || data['taille de l\'entreprise'] || '';
      const headquarters = data['headquarters'] || data['siège social'] || '';
      const founded = data['founded'] || data['fondée en'] || '';

      // ── Specialties ──
      let specialties = [];
      const specRaw = data['specialties'] || data['spécialisations'] || '';
      if (specRaw) {
        specialties = specRaw.split(',').map(s => s.trim()).filter(Boolean);
      }

      // Clean the company URL to remove /about/
      let cleanUrl = originalUrl.replace(/\/about\/?$/, '/');

      return {
        name,
        tagline,
        industry,
        companySize,
        headquarters,
        website,
        founded,
        specialties,
        about,
        companyUrl: cleanUrl
      };
    }, companyUrl);

    if (!company.name) {
      return res.status(404).json({ success: false, error: 'Company not found or page could not be parsed' });
    }

    console.log(`[${ts()}] Scraped company: ${company.name}`);
    res.json({ success: true, company });

  } catch (err) {
    console.error(`[${ts()}] Company scrape error:`, err.message);
    if (err.message.includes('ERR_TOO_MANY_REDIRECTS')) {
      return res.status(401).json({ success: false, error: 'Too many redirects — cookie is invalid or expired. Use POST /login to re-authenticate from this server.' });
    }
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
  }
});

// ─── Startup ─────────────────────────────────────────────────────────

(async () => {
  try {
    await launchBrowser();
  } catch (err) {
    console.error(`[${ts()}] Failed to launch browser:`, err.message);
    console.error('Server will start but scraping will fail until browser is available.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[${ts()}] LinkedIn scraper running on http://0.0.0.0:${PORT}`);
  });
})();
