// A small WordPress export, and the bytes of a picture, shared by the import tests.
// a 1x1 PNG, a JPEG header, a GIF header
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

export const WXR = `<?xml version="1.0" encoding="UTF-8" ?>
<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wfw="http://wellformedweb.org/CommentAPI/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
  <title>Ada &amp; Friends</title>
  <link>https://old.example.org</link>
  <description>Notes &amp;xxe; from the old blog</description>
  <language>en-US</language>
  <wp:base_site_url>https://old.example.org</wp:base_site_url>
  <wp:base_blog_url>https://old.example.org</wp:base_blog_url>
  <wp:author><wp:author_id>1</wp:author_id><wp:author_login><![CDATA[ada]]></wp:author_login><wp:author_display_name><![CDATA[Ada Example]]></wp:author_display_name></wp:author>
  <wp:author><wp:author_id>2</wp:author_id><wp:author_login><![CDATA[bob]]></wp:author_login><wp:author_display_name><![CDATA[Bob Guest]]></wp:author_display_name></wp:author>

  <item>
    <title>Hello &amp;amp; welcome</title>
    <link>https://old.example.org/2024/05/hello-welcome/</link>
    <dc:creator><![CDATA[ada]]></dc:creator>
    <content:encoded><![CDATA[<!-- wp:paragraph -->
<p>First <strong>bold</strong> and <em>italic</em> and <a href="https://example.com/x">a link</a>.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":4} -->
<h4>Small heading</h4>
<!-- /wp:heading -->

<ul><li>one</li><li>two<ul><li>two-a</li></ul></li></ul>
<blockquote><p>Quoted words</p></blockquote>
<pre class="wp-block-code"><code>let a = 1;
let b = 2;</code></pre>
<figure class="wp-block-image"><a href="https://old.example.org/wp-content/uploads/2024/05/cat.jpg"><img src="https://old.example.org/wp-content/uploads/2024/05/cat-300x200.jpg" alt="A cat"/></a><figcaption>My cat</figcaption></figure>
<p>See <a href="https://old.example.org/2024/06/second-post/">the second post</a> and <a href="/about-us/">about</a>.</p>
<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
<iframe src="https://www.youtube.com/embed/abc"></iframe>
<p>Elsewhere: <img src="https://other.example.net/pic.png" alt="far"></p>
<p>Read <a href="https://old.example.org/wp-content/uploads/2022/01/paper.pdf">the paper</a>.</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[A short excerpt.]]></excerpt:encoded>
    <wp:post_id>10</wp:post_id>
    <wp:post_date>2024-05-02 09:30:00</wp:post_date>
    <wp:post_name><![CDATA[hello-welcome]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_type><![CDATA[post]]></wp:post_type>
    <category domain="category" nicename="news"><![CDATA[News]]></category>
    <category domain="category" nicename="uncategorized"><![CDATA[Uncategorized]]></category>
    <category domain="post_tag" nicename="video-git"><![CDATA[Video, Git]]></category>
    <wp:postmeta><wp:meta_key><![CDATA[_thumbnail_id]]></wp:meta_key><wp:meta_value><![CDATA[31]]></wp:meta_value></wp:postmeta>
    <wp:comment><wp:comment_id>1</wp:comment_id><wp:comment_author><![CDATA[Zed]]></wp:comment_author><wp:comment_author_email><![CDATA[zed@private.example]]></wp:comment_author_email><wp:comment_author_IP>203.0.113.9</wp:comment_author_IP><wp:comment_date>2024-05-03 10:00:00</wp:comment_date><wp:comment_content><![CDATA[Nice <b>post</b>!

Second paragraph.]]></wp:comment_content><wp:comment_approved>1</wp:comment_approved><wp:comment_type></wp:comment_type><wp:comment_parent>0</wp:comment_parent></wp:comment>
    <wp:comment><wp:comment_id>2</wp:comment_id><wp:comment_author><![CDATA[Ada Example]]></wp:comment_author><wp:comment_date>2024-05-04 08:00:00</wp:comment_date><wp:comment_content><![CDATA[Thanks, Zed.]]></wp:comment_content><wp:comment_approved>1</wp:comment_approved><wp:comment_type>comment</wp:comment_type><wp:comment_parent>1</wp:comment_parent></wp:comment>
    <wp:comment><wp:comment_id>3</wp:comment_id><wp:comment_author><![CDATA[Spammer]]></wp:comment_author><wp:comment_date>2024-05-05 08:00:00</wp:comment_date><wp:comment_content><![CDATA[Buy things]]></wp:comment_content><wp:comment_approved>spam</wp:comment_approved><wp:comment_type></wp:comment_type><wp:comment_parent>0</wp:comment_parent></wp:comment>
    <wp:comment><wp:comment_id>4</wp:comment_id><wp:comment_author><![CDATA[Some blog]]></wp:comment_author><wp:comment_date>2024-05-06 08:00:00</wp:comment_date><wp:comment_content><![CDATA[Pingback text]]></wp:comment_content><wp:comment_approved>1</wp:comment_approved><wp:comment_type>pingback</wp:comment_type><wp:comment_parent>0</wp:comment_parent></wp:comment>
  </item>

  <item>
    <title>Second post</title>
    <link>https://old.example.org/2024/06/second-post/</link>
    <dc:creator><![CDATA[bob]]></dc:creator>
    <content:encoded><![CDATA[Plain text paragraph one.

Paragraph two with a [caption id="a" width="1"]<img src="/wp-content/uploads/2024/06/dog.jpg"> A dog[/caption] inside, and [gallery ids="31,32"] and [sic] and [fancy_form id="3"].

A line
with a break.]]></content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>11</wp:post_id>
    <wp:post_date>2024-06-10 12:00:00</wp:post_date>
    <wp:post_name><![CDATA[second-post]]></wp:post_name>
    <wp:status><![CDATA[publish]]></wp:status>
    <wp:post_type><![CDATA[post]]></wp:post_type>
  </item>

  <item>
    <title>Not ready</title><link>https://old.example.org/?p=12</link><dc:creator>ada</dc:creator>
    <content:encoded><![CDATA[<p>Draft words</p>]]></content:encoded><excerpt:encoded></excerpt:encoded>
    <wp:post_id>12</wp:post_id><wp:post_date>0000-00-00 00:00:00</wp:post_date><wp:post_name></wp:post_name>
    <wp:status>draft</wp:status><wp:post_type>post</wp:post_type>
  </item>
  <item>
    <title>Secret</title><link>https://old.example.org/?p=13</link><dc:creator>ada</dc:creator>
    <content:encoded><![CDATA[<p>Private words</p>]]></content:encoded><excerpt:encoded></excerpt:encoded>
    <wp:post_id>13</wp:post_id><wp:post_date>2024-07-01 00:00:00</wp:post_date><wp:post_name>secret</wp:post_name>
    <wp:status>private</wp:status><wp:post_type>post</wp:post_type>
  </item>
  <item>
    <title>Gone</title><wp:post_id>14</wp:post_id><wp:post_date>2024-07-01 00:00:00</wp:post_date><wp:status>trash</wp:status><wp:post_type>post</wp:post_type>
    <content:encoded><![CDATA[<p>never</p>]]></content:encoded>
  </item>
  <item>
    <title>About us</title><link>https://old.example.org/about-us/</link><dc:creator>ada</dc:creator>
    <content:encoded><![CDATA[<p>We write things.</p>]]></content:encoded><excerpt:encoded></excerpt:encoded>
    <wp:post_id>20</wp:post_id><wp:post_date>2023-01-01 00:00:00</wp:post_date><wp:post_name>about-us</wp:post_name><wp:menu_order>0</wp:menu_order>
    <wp:status>publish</wp:status><wp:post_type>page</wp:post_type>
  </item>
  <item>
    <title>Tags</title><link>https://old.example.org/tags/</link><dc:creator>ada</dc:creator>
    <content:encoded><![CDATA[<p>A page whose slug the new blog reserves.</p>]]></content:encoded><excerpt:encoded></excerpt:encoded>
    <wp:post_id>21</wp:post_id><wp:post_date>2023-01-01 00:00:00</wp:post_date><wp:post_name>tags</wp:post_name>
    <wp:status>publish</wp:status><wp:post_type>page</wp:post_type>
  </item>
  <item>
    <title>Menu: About</title><wp:post_id>40</wp:post_id><wp:post_date>2023-01-01 00:00:00</wp:post_date><wp:menu_order>1</wp:menu_order>
    <wp:status>publish</wp:status><wp:post_type>nav_menu_item</wp:post_type>
    <wp:postmeta><wp:meta_key>_menu_item_object</wp:meta_key><wp:meta_value>page</wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key>_menu_item_object_id</wp:meta_key><wp:meta_value>20</wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key>_menu_item_menu_item_parent</wp:meta_key><wp:meta_value>0</wp:meta_value></wp:postmeta>
  </item>
  <item>
    <title>Widget</title><wp:post_id>50</wp:post_id><wp:post_date>2023-01-01 00:00:00</wp:post_date><wp:status>publish</wp:status><wp:post_type>product</wp:post_type>
  </item>
  <item>
    <title>cat</title><wp:post_id>31</wp:post_id><wp:post_date>2024-05-02 00:00:00</wp:post_date><wp:status>inherit</wp:status><wp:post_type>attachment</wp:post_type>
    <wp:attachment_url>https://old.example.org/wp-content/uploads/2024/05/cat.jpg</wp:attachment_url><wp:post_parent>10</wp:post_parent>
    <wp:postmeta><wp:meta_key>_wp_attachment_image_alt</wp:meta_key><wp:meta_value>A cat</wp:meta_value></wp:postmeta>
  </item>
  <item>
    <title>dog</title><wp:post_id>32</wp:post_id><wp:post_date>2024-06-10 00:00:00</wp:post_date><wp:status>inherit</wp:status><wp:post_type>attachment</wp:post_type>
    <wp:attachment_url>https://old.example.org/wp-content/uploads/2024/06/dog.jpg</wp:attachment_url><wp:post_parent>11</wp:post_parent>
  </item>
  <item>
    <title>unused</title><wp:post_id>33</wp:post_id><wp:post_date>2022-01-01 00:00:00</wp:post_date><wp:status>inherit</wp:status><wp:post_type>attachment</wp:post_type>
    <wp:attachment_url>https://old.example.org/wp-content/uploads/2022/01/My Unused Photo.JPG</wp:attachment_url><wp:post_parent>0</wp:post_parent>
  </item>
  <item>
    <title>doc</title><wp:post_id>34</wp:post_id><wp:post_date>2022-01-01 00:00:00</wp:post_date><wp:status>inherit</wp:status><wp:post_type>attachment</wp:post_type>
    <wp:attachment_url>https://old.example.org/wp-content/uploads/2022/01/paper.pdf</wp:attachment_url>
  </item>
</channel>
</rss>`;

