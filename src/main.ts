import Apify from 'apify';
import { InfoError } from './error';
import { LABELS, CSS_SELECTORS } from './constants';
import {
    getUrlLabel,
    setLanguageCodeToCookie,
    userAgents,
    normalizeOutputPageUrl,
    extractUsernameFromUrl,
    generateSubpagesFromUrl,
    stopwatch,
    executeOnDebug,
    parseRelativeDate,
} from './functions';
import {
    getPagesFromListing,
    getPageInfo,
    getPostUrls,
    getFieldInfos,
    getReviews,
    getPostContent,
    getPostComments,
    getServices,
    getPostInfoFromScript,
    isNotFoundPage,
} from './page';
import { statePersistor, emptyState } from './storage';
import type { Schema, FbLabel, FbSection } from './definitions';

import LANGUAGES = require('./languages.json');

const { log, puppeteer } = Apify.utils;

Apify.main(async () => {
    const input: Schema | null = await Apify.getInput();

    if (!input || typeof input !== 'object') {
        throw new Error('Missing input');
    }

    const {
        startUrls,
        proxyConfiguration,
        maxPosts = 3,
        maxPostDate,
        maxPostComments = 15,
        maxReviewDate,
        maxCommentDate,
        maxReviews = 3,
        commentsMode = 'RANKED_THREADED',
        scrapeAbout = true,
        scrapeReviews = true,
        scrapePosts = true,
        scrapeServices = true,
        language = 'en-US',
        sessionStorage = '',
        useStealth = false,
    } = input;

    if (!Array.isArray(startUrls) || !startUrls.length) {
        throw new Error('You must provide the "startUrls" input');
    }

    if (!Number.isFinite(maxPostComments)) {
        throw new Error('You must provide a finite number for "maxPostComments" input');
    }

    if (Apify.isAtHome() && !proxyConfiguration) {
        throw new Error('You must specify a proxy');
    }

    let handlePageTimeoutSecs = Math.round(60 * (((maxPostComments + maxPosts) || 10) * 0.01)) + 300; // minimum 300s

    if (handlePageTimeoutSecs * 60000 >= 0x7FFFFFFF) {
        log.warning(`maxPosts + maxPostComments parameter is too high, must be less than ${0x7FFFFFFF} milliseconds in total, got ${handlePageTimeoutSecs * 60000}. Loading posts and comments might never finish or crash the scraper at any moment.`, {
            maxPostComments,
            maxPosts,
            handlePageTimeoutSecs,
            handlePageTimeout: handlePageTimeoutSecs * 60000,
        });
        handlePageTimeoutSecs = Math.floor(0x7FFFFFFF / 60000);
    }

    log.info(`Will use ${handlePageTimeoutSecs}s timeout for page`);

    let requestListSources;
    for (const startUrl of startUrls) {
        Apify.utils.log.info(`startUrl: ${startUrl}`);
        if (startUrl){
          const {requestsFromUrl} = startUrl;
          Apify.utils.log.info(`requestsFromUrl: ${requestsFromUrl}`);
          if (requestsFromUrl){
              const { body } = await Apify.utils.requestAsBrowser({ url: requestsFromUrl, encoding:'utf-8' });
              let lines = body.split('\n');
              delete  lines[0]
              requestListSources = lines.map(line => {
                  let [id, url] = line.trim().split('\t');
                  if (!url) { return false }
                  if (!/http(s?):\/\//g.test(url)) {
                      url = `http://${url}`
                  }
                  Apify.utils.log.info(`csv extraction: id: ${id} url ${url}`);
                  return {url, userData: {id}};
              }).filter(req => !!req);
          }
        }
    }
    const startUrlsRequests = new Apify.RequestList({
        sources: requestListSources,
    });

    await startUrlsRequests.initialize();

    if (!(language in LANGUAGES)) {
        throw new Error(`Selected language "${language}" isn't supported`);
    }

    const { map, state, persistState } = await statePersistor();
    const elapsed = stopwatch();

    log.info(`Starting crawler with ${startUrlsRequests.length()} urls`);
    log.info(`Using language "${(LANGUAGES as any)[language]}" (${language})`);

    const processedPostDate = maxPostDate ? parseRelativeDate(maxPostDate) : null;

    if (processedPostDate) {
        log.info(`Getting posts from ${new Date(processedPostDate).toLocaleString()} and newer`);
    }

    const processedCommentDate = maxCommentDate ? parseRelativeDate(maxCommentDate) : null;

    if (processedCommentDate) {
        log.info(`Getting comments from ${new Date(processedCommentDate).toLocaleString()} and newer`);
    }

    const processedReviewDate = maxReviewDate ? parseRelativeDate(maxReviewDate) : null;

    if (processedReviewDate) {
        log.info(`Getting reviews from ${new Date(processedReviewDate).toLocaleString()} and newer`);
    }

    const requestQueue = await Apify.openRequestQueue();

    let nextRequest;
    const processedRequests = new Set<Apify.Request>();

    // eslint-disable-next-line no-cond-assign
    while (nextRequest = await startUrlsRequests.fetchNextRequest()) {
        processedRequests.add(nextRequest);
    }

    if (!processedRequests.size) {
        throw new Error('No requests were loaded from startUrls');
    }

    const initSubPage = async (subpage: { url: string; section: FbSection, dtId: string }, url: string) => {
        if (subpage.section === 'home') {
            const username = extractUsernameFromUrl(subpage.url);

            // initialize the page. if it's already initialized,
            // use the current content
            await map.append(username, async (value) => {
                return {
                    ...emptyState(),
                    pageUrl: normalizeOutputPageUrl(subpage.url),
                    '#url': subpage.url,
                    '#ref': url,
                    ...value,
                };
            });
        }

        await requestQueue.addRequest({
            url: subpage.url,
            userData: {
                label: 'PAGE' as FbLabel,
                sub: subpage.section,
                id: subpage.dtId,
                ref: url,
                useMobile: true,
            },
        });
    };

    const pageInfo = [
        ...(scrapePosts ? ['posts'] : []),
        ...(scrapeAbout ? ['about'] : []),
        ...(scrapeReviews ? ['reviews'] : []),
        ...(scrapeServices ? ['services'] : []),
    ] as FbSection[];

    for (const request of processedRequests) {
        try {
            const { url, userData } = request;
            const urlType = getUrlLabel(url);

            if (urlType === 'PAGE') {
                for (const subpage of generateSubpagesFromUrl(url, pageInfo)) {
                    await initSubPage({
                      dtId: userData.id,
                      ...subpage
                    }, url);
                }
            } else if (urlType === 'LISTING') {
                await requestQueue.addRequest({
                    url,
                    userData: {
                        id: userData.id,
                        label: urlType,
                        useMobile: false,
                    },
                });
            }
        } catch (e) {
            if (e instanceof InfoError) {
                // We want to inform the rich error before throwing
                log.warning(e.message, e.toJSON());
            } else {
                throw e;
            }
        }
    }

    const maxConcurrency = process.env?.MAX_CONCURRENCY ? +process.env.MAX_CONCURRENCY : undefined;
    const proxyConfig = await Apify.createProxyConfiguration({
        ...proxyConfiguration,
    });

    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        useSessionPool: true,
        sessionPoolOptions: {
            persistStateKeyValueStoreId: sessionStorage || undefined,
            maxPoolSize: sessionStorage ? 1 : undefined,
        },
        maxRequestRetries: 5,
        autoscaledPoolOptions: {
            // make it easier to debug locally with slowMo without switching tabs
            maxConcurrency,
        },
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: maxConcurrency,
        },
        proxyConfiguration: proxyConfig || undefined,
        launchPuppeteerFunction: async (options) => {
            return Apify.launchPuppeteer({
                ...options,
                slowMo: log.getLevel() === log.LEVELS.DEBUG ? 100 : undefined,
                useChrome: Apify.isAtHome(),
                stealth: useStealth,
                stealthOptions: {
                    addLanguage: false,
                    addPlugins: false,
                    emulateConsoleDebug: false,
                    emulateWebGL: false,
                    hideWebDriver: true,
                    emulateWindowFrame: false,
                    hackPermissions: false,
                    mockChrome: false,
                    mockDeviceMemory: false,
                    mockChromeInIframe: false,
                },
                args: [
                    ...options?.args,
                    '--disable-setuid-sandbox',
                ],
            });
        },
        persistCookiesPerSession: sessionStorage !== '',
        handlePageTimeoutSecs, // more comments, less concurrency
        gotoFunction: async ({ page, request, puppeteerPool }) => {
            await setLanguageCodeToCookie(language, page);

            await executeOnDebug(async () => {
                await page.exposeFunction('logMe', (...args) => {
                    console.log(...args);
                });
            });

            await page.exposeFunction('unhideChildren', (element?: HTMLElement) => {
                // weird bugs happen in this function, sometimes the dom element has no querySelectorAll for
                // unknown reasons
                if (!element) {
                    return;
                }

                element.className = '';
                if (typeof element.removeAttribute === 'function') {
                    // weird bug that sometimes removeAttribute isn't a function?
                    element.removeAttribute('style');
                }

                if (typeof element.querySelectorAll === 'function') {
                    for (const el of [...element.querySelectorAll<HTMLElement>('*')]) {
                        el.className = ''; // removing the classes usually unhides

                        if (typeof element.removeAttribute === 'function') {
                            el.removeAttribute('style');
                        }
                    }
                }
            });

            // make the page a little more lightweight
            await puppeteer.blockRequests(page, {
                urlPatterns: [
                    '.woff',
                    '.webp',
                    '.mov',
                    '.mpeg',
                    '.mpg',
                    '.mp4',
                    '.woff2',
                    '.ttf',
                    '.ico',
                    'scontent-',
                    'scontent.fplu',
                    'safe_image.php',
                    'static_map.php',
                    'ajax/bz',
                ],
            });

            const { userData: { useMobile } } = request;

            // listing need to start in a desktop version
            // page needs a mobile viewport
            const { data } = useMobile
                ? userAgents.mobile()
                : userAgents.desktop();

            request.userData.userAgent = data.userAgent;

            await page.emulate({
                userAgent: data.userAgent,
                viewport: {
                    height: useMobile ? 740 : 1080,
                    width: useMobile ? 360 : 1920,
                    hasTouch: useMobile,
                    isMobile: useMobile,
                    deviceScaleFactor: useMobile ? 4 : 1,
                },
            });

            try {
                const response = await page.goto(request.url, {
                    waitUntil: 'networkidle2',
                    timeout: 60000,
                });

                return response;
            } catch (e) {
                log.exception(e, 'gotoFunction', {
                    url: request.url,
                    userData: request.userData,
                });

                await puppeteerPool.retire(page.browser());

                return null;
            }
        },
        handlePageFunction: async ({ request, page, puppeteerPool, session }) => {
            const { userData } = request;

            const label: FbLabel = userData.label; // eslint-disable-line prefer-destructuring

            log.info(`Visiting page ${request.url} - ${label} - ${userData.sub}`);

            try {
                if (userData.useMobile) {
                    // need to do some checks if the current mobile page is the interactive one or if
                    // it has been blocked
                    if (await page.$(CSS_SELECTORS.MOBILE_CAPTCHA)) {
                        throw new InfoError('Mobile captcha found', {
                            url: request.url,
                            namespace: 'captcha',
                            userData,
                        });
                    }

                    try {
                        await Promise.all([
                            page.waitForSelector(CSS_SELECTORS.MOBILE_META, {
                                timeout: 3000, // sometimes the page takes a while to load the responsive interactive version
                            }),
                            page.waitForSelector(CSS_SELECTORS.MOBILE_BODY_CLASS, {
                                timeout: 3000, // correctly detected android. if this isn't the case, the image names will change
                            }),
                        ]);
                    } catch (e) {
                        throw new InfoError('An unexpected page layout was returned by the server. This request will be retried shortly.', {
                            url: request.url,
                            namespace: 'mobile-meta',
                            userData,
                        });
                    }
                }

                if (!userData.useMobile && await page.$(CSS_SELECTORS.DESKTOP_CAPTCHA)) {
                    throw new InfoError('Desktop captcha found', {
                        url: request.url,
                        namespace: 'captcha',
                        userData,
                    });
                }

                if (label !== 'LISTING' && await isNotFoundPage(page)) {
                    request.noRetry = true;

                    // throw away if page is not available
                    // but inform the user of error
                    throw new InfoError('Content not found. This either means the page doesn\'t exist, or the section itself doesn\'t exist (about, reviews, services)', {
                        url: request.url,
                        namespace: 'isNotFoundPage',
                        userData,
                    });
                }

                if (label === LABELS.LISTING) {
                    const start = stopwatch();
                    const pagesUrls = await getPagesFromListing(page);

                    for (const url of pagesUrls) {
                        for (const subpage of generateSubpagesFromUrl(url, pageInfo)) {
                            await initSubPage(subpage, request.url);
                        }
                    }

                    log.info(`Got ${pagesUrls.size} pages from listing in ${start() / 1000}s`);
                } else if (userData.label === LABELS.PAGE) {
                    const username = extractUsernameFromUrl(request.url);

                    switch (userData.sub) {
                        // Main landing page
                        case 'home':
                            await map.append(username, async (value) => {
                                const {
                                    likes,
                                    messenger,
                                    title,
                                    verified,
                                    ...address
                                } = await getPageInfo(page);
                                let fieldsInfo = await getFieldInfos(page, {
                                    ...value,
                                    likes,
                                    messenger,
                                    title,
                                    verified,
                                    address: {
                                        lat: null,
                                        lng: null,
                                        ...value?.address,
                                        ...address,
                                    },
                                })
                                return {
                                    ...fieldsInfo,
                                    label,
                                    dtId: userData.id,
                                }
                            });
                            break;
                        // Services if any
                        case 'services':
                            try {
                                const services = await getServices(page);

                                if (services.length) {
                                    await map.append(username, async (value) => {
                                        return {
                                            ...value,
                                            services: [
                                                ...(value?.services ?? []),
                                                ...services,
                                            ],
                                        };
                                    });
                                }
                            } catch (e) {
                                // it's ok to fail here, not every page has services
                                log.debug(e.message);
                            }
                            break;
                        // About if any
                        case 'about':
                            await map.append(username, async (value) => {
                                return getFieldInfos(page, {
                                    ...value,
                                });
                            });

                            break;
                        // Posts
                        case 'posts':
                            // We don't do anything here, we enqueue posts to be
                            // read on their own phase/label
                            await getPostUrls(page, {
                                max: maxPosts,
                                date: processedPostDate,
                                username,
                                requestQueue,
                            });

                            break;
                        // Reviews if any
                        case 'reviews':
                            try {
                                const reviewsData = await getReviews(page, {
                                    max: maxReviews,
                                    date: processedReviewDate,
                                });

                                if (reviewsData) {
                                    const { average, count, reviews } = reviewsData;

                                    await map.append(username, async (value) => {
                                        return {
                                            ...value,
                                            reviews: {
                                                ...(value?.reviews ?? {}),
                                                average,
                                                count,
                                                reviews: [
                                                    ...reviews,
                                                    ...(value?.reviews?.reviews ?? []),
                                                ],
                                            },
                                        };
                                    });
                                }
                            } catch (e) {
                                // it's ok for failing here, not every page has reviews
                                log.debug(e.message);
                            }
                            break;
                        // make eslint happy
                        default:
                            throw new InfoError(`Unknown subsection ${userData.sub}`, {
                                url: request.url,
                                namespace: 'handlePageFunction',
                            });
                    }
                } else if (label === LABELS.POST) {
                    const postTimer = stopwatch();

                    log.debug('Started processing post', { url: request.url });

                    // actually parse post content here, it doesn't work on
                    // mobile address
                    const { username, canonical } = userData;

                    const [postStats, content] = await Promise.all([
                        getPostInfoFromScript(page, canonical),
                        getPostContent(page),
                    ]);

                    const postComments = await getPostComments(page, {
                        max: maxPostComments,
                        mode: commentsMode,
                        date: processedCommentDate,
                    });

                    await map.append(username, async (value) => {
                        return {
                            ...value,
                            posts: [
                                {
                                    ...content,
                                    postStats,
                                    postComments,
                                },
                                ...(value?.posts ?? []),
                            ],
                        };
                    });

                    log.info(`Processed post in ${postTimer() / 1000}s`, { url: request.url });
                } else {
                    throw new InfoError(`Invalid label found ${userData.label}`, {
                        url: request.url,
                        namespace: 'handlePageFunction',
                    });
                }
            } catch (e) {
                log.debug(e.message, {
                    url: request.url,
                    userData: request.userData,
                    error: e,
                });

                session?.markBad();

                if (e instanceof InfoError) {
                    // We want to inform the rich error before throwing
                    log.warning(e.message, e.toJSON());

                    if (['captcha', 'mobile-meta', 'getFieldInfos'].includes(e.meta.namespace)) {
                        // the session is really bad
                        session?.retire();
                        await puppeteerPool.retire(page.browser());
                    }
                }

                throw e;
            }

            log.debug(`Done with page ${request.url}`);
        },
        handleFailedRequestFunction: async ({ request, error }) => {
            if (error instanceof InfoError) {
                // this only happens when maxRetries is
                // comprised mainly of InfoError, which is usually a problem
                // with pages
                log.exception(error, 'handleFailedRequestFunction', error.toJSON());
            } else {
                log.error(`Requests failed on ${request.url} after ${request.retryCount} retries`);
            }
        },
    });

    await crawler.run();

    await persistState();

    log.info('Generating dataset...');

    const finished = new Date().toISOString();

    // generate the dataset from all the crawled pages
    await Apify.pushData([...state.values()].filter(s => s.categories?.length).map(val => ({
        ...val,
        "#version": 2, // current data format version
        '#finishedAt': finished,
    })));

    log.info(`Done in ${Math.round(elapsed() / 60000)}m!`);
});
