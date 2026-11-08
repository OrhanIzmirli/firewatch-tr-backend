import type { Pool } from 'pg';
import { MatchArticle, isForestFireStory, isStoryAboutProvince, withinDayWindow } from './incidentNewsMatch';
import { withFormerNames } from './provinces';

export interface RelatedArticle {
  id: number;
  title: string;
  source: string;
  url: string | null;
  published_at: string;
}

/** Same story and province gates as "confirmed by news", newest first. */
export async function relatedNews(
  db: Pick<Pool, 'query'>,
  city: string | null,
  from: Date,
  to: Date,
  limit: number
): Promise<RelatedArticle[]> {
  const [news, cities] = await Promise.all([
    db.query(
      `SELECT id, title, summary, source, source_url, COALESCE(published_at, created_at) AS at
         FROM news
        WHERE COALESCE(published_at, created_at) BETWEEN $1::timestamptz - interval '1 day' AND $2::timestamptz + interval '1 day'
        ORDER BY at DESC
        LIMIT 400`,
      [from, to]
    ),
    db.query(`SELECT name FROM turkey_cities`),
  ]);
  const cityNames = withFormerNames(cities.rows.map((r: any) => String(r.name)));
  const out: RelatedArticle[] = [];
  for (const r of news.rows) {
    const article: MatchArticle = { id: Number(r.id), title: r.title, summary: r.summary, publishedAt: new Date(r.at) };
    if (!withinDayWindow(article.publishedAt, from, to)) continue;
    const ok = city ? isStoryAboutProvince(article, city, cityNames) : isForestFireStory(article);
    if (!ok) continue;
    out.push({ id: article.id, title: r.title, source: r.source, url: r.source_url, published_at: article.publishedAt.toISOString() });
    if (out.length >= limit) break;
  }
  return out;
}
