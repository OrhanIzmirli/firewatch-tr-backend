import cron from 'node-cron';
import newsService from '../services/newsService';

class NewsScraperJob {
  start() {
    console.log('News Scraper Job starting...');

    cron.schedule('0 */6 * * *', async () => {
      try {
        console.log('Running news scraper job at:', new Date().toISOString());

        const mockNews: any[] = [
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
          await newsService.createNews(news);
          console.log(`Created news: ${news.title}`);
        }

        console.log('News scraper job completed successfully');
      } catch (error) {
        console.error('Error in news scraper job:', error);
      }
    });
  }
}

export default new NewsScraperJob();