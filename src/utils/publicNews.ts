import { News } from '../types';
import { provinceInTitle } from './newsGeography';
import { withSourceLogo } from './newsSourceLogos';

export type PublicNews = Omit<News, 'image_url' | 'thumbnail_url'> & {
  source_logo_url: string;
  province: string | null;
  thumb_path: string | null;
};

/**
 * What leaves the API: headline, source and link. Any older client still
 * reads the text fields, so they stay present and empty.
 */
export function toPublicNews(row: News): PublicNews {
  const { image_url: _image, thumbnail_url: _thumb, ...rest } = row;
  const province = provinceInTitle(row.title);
  const when = row.published_at ?? row.created_at;
  return {
    ...withSourceLogo(rest),
    summary: '',
    body: '',
    highlights: [],
    paragraphs: [],
    province,
    thumb_path: province && when ? `/api/news/thumb/${encodeURIComponent(province)}/${new Date(when).toISOString().slice(0, 10)}` : null,
  };
}
