const { query, connectDB } = require('./db/client');

async function reset() {
  const res = await query(`
    WITH page_counts AS (
      SELECT metadata->>'page_slug' AS slug, COUNT(*) AS cnt
      FROM events
      WHERE event_type = 'page_view'
      GROUP BY metadata->>'page_slug'
    )
    UPDATE content_pages
    SET total_visitors = COALESCE((SELECT cnt FROM page_counts WHERE slug = content_pages.slug), 0)
    RETURNING slug, total_visitors
  `);
  return res.rows;
}

module.exports = reset;