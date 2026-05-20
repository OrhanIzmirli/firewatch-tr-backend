"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const newsService_1 = __importDefault(require("../services/newsService"));
class NewsScraperJob {
    start() {
        console.log('News Scraper Job starting...');
        node_cron_1.default.schedule('0 */6 * * *', async () => {
            try {
                console.log('Running news scraper job at:', new Date().toISOString());
                const mockNews = [
                    {
                        title: 'Wildfire spreads in Muğla region',
                        summary: 'Major wildfire spreads rapidly',
                        body: 'A major wildfire is spreading in the Muğla region of Turkey...',
                        source: 'Local News',
                        source_url: 'https://example.com/news/1',
                        category: 'Alert',
                        is_breaking: true,
                        published_at: new Date(),
                        read_minutes: 5,
                        related_region: 'Muğla',
                    },
                    {
                        title: 'Fire prevention tips for summer',
                        summary: 'How to prevent wildfires',
                        body: 'Here are some important tips to prevent wildfires during summer months...',
                        source: 'Safety Guide',
                        source_url: 'https://example.com/news/2',
                        category: 'Safety',
                        is_breaking: false,
                        published_at: new Date(),
                        read_minutes: 3,
                        related_region: 'Turkey',
                    },
                ];
                for (const news of mockNews) {
                    await newsService_1.default.createNews(news);
                    console.log(`Created news: ${news.title}`);
                }
                console.log('News scraper job completed successfully');
            }
            catch (error) {
                console.error('Error in news scraper job:', error);
            }
        });
    }
}
exports.default = new NewsScraperJob();
