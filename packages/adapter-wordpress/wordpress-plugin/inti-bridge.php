<?php
/**
 * Plugin Name: Inti Bridge
 * Plugin URI: https://github.com/intijs/inti
 * Description: Companion plugin for Inti.js on Astro: atomic writes with conflict detection, signed purge notices, parsed blocks, menus and languages in REST, and Abilities API registrations.
 * Version: 0.2.0
 * Requires at least: 6.5
 * Requires PHP: 7.4
 * Author: Victor Antinori Broce
 * License: MIT
 *
 * REST (namespace inti/v1):
 *   POST /patch    one field of a Flexible Content row, or of the page
 *   POST /rows     move, insert, remove, duplicate or replace rows, server side
 *   POST /content  the whole post_content (Gutenberg mode)
 *   GET  /menus/<location>   the menu assigned to a theme location (public)
 *   GET  /status   what this plugin supports (authenticated)
 *
 * Every write accepts `expected_modified` (the post's `modified_gmt` as the
 * writer read it) and answers 409 when the post changed since: an edit never
 * silently overwrites someone else's.
 *
 * Fields added to every REST post type: `inti_blocks` (parse_blocks, with the
 * rendered HTML of bound and dynamic blocks), `inti_locale` and
 * `inti_translations` (Polylang or WPML).
 *
 * Purge notices: define INTI_PURGE_URL and INTI_PURGE_SECRET in wp-config.php
 * (or the options `inti_purge_url` / `inti_purge_secret`). When a published
 * post changes or is deleted, the site receives a POST signed with
 * `X-Inti-Signature: sha256=<HMAC-SHA256 of the body>`.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('INTI_BRIDGE_VERSION', '0.2.0');

// ============================================
// Helpers
// ============================================

/** The post's modification date as REST reports `modified_gmt` */
function inti_bridge_modified($post_id) {
    $post = get_post($post_id);
    return $post ? mysql_to_rfc3339($post->post_modified_gmt) : null;
}

/** `2026-11-20T10:00:00`, `2026-11-20T10:00:00Z` and `…+00:00` are the same instant */
function inti_bridge_same_instant($a, $b) {
    $ta = strtotime(preg_match('/(Z|[+-]\d\d:?\d\d)$/', $a) ? $a : $a . 'Z');
    $tb = strtotime(preg_match('/(Z|[+-]\d\d:?\d\d)$/', $b) ? $b : $b . 'Z');
    return $ta !== false && $ta === $tb;
}

/**
 * 409 when the writer read an older version than the stored one.
 * Without `expected_modified` the write goes through, as before.
 */
function inti_bridge_check_version(WP_REST_Request $request, $post_id) {
    $expected = $request->get_param('expected_modified');
    if (!$expected) {
        return null;
    }
    $current = inti_bridge_modified($post_id);
    if ($current && !inti_bridge_same_instant($expected, $current)) {
        return new WP_Error(
            'inti_conflict',
            'The page changed in WordPress since it was read. Reload it and edit again.',
            array('status' => 409, 'modified_gmt' => $current)
        );
    }
    return null;
}

/**
 * `update_field` does not touch post_modified. The write is a change to the
 * page, so the date moves: the next writer's version check sees it.
 */
function inti_bridge_touch($post_id) {
    wp_update_post(array('ID' => $post_id), false, false);
    clean_post_cache($post_id);
    inti_bridge_queue_purge($post_id, 'post.updated');
    return inti_bridge_modified($post_id);
}

function inti_bridge_written($post_id, array $extra = array()) {
    return rest_ensure_response(array_merge(
        array('success' => true, 'post_id' => $post_id, 'modified_gmt' => inti_bridge_touch($post_id), 'atomic' => true),
        $extra
    ));
}

function inti_bridge_no_acf() {
    return new WP_Error('inti_no_acf', 'ACF (or Secure Custom Fields) is not active on this site', array('status' => 501));
}

/** Path of a post as the site routes it: `about`, `services/design`; `home` for the front page */
function inti_bridge_path($post) {
    $post = get_post($post);
    if (!$post) {
        return null;
    }
    if ((int) get_option('page_on_front') === (int) $post->ID) {
        return 'home';
    }
    if (is_post_type_hierarchical($post->post_type)) {
        return get_page_uri($post);
    }
    return $post->post_name;
}

// ============================================
// Permissions
// ============================================

function inti_bridge_can_edit(WP_REST_Request $request) {
    $post_id = (int) $request->get_param('post_id');
    return $post_id > 0 && current_user_can('edit_post', $post_id);
}

// ============================================
// Routes
// ============================================

add_action('rest_api_init', function () {
    $post_args = array(
        'post_id'           => array('required' => true, 'type' => 'integer'),
        'expected_modified' => array('required' => false, 'type' => 'string'),
    );

    register_rest_route('inti/v1', '/patch', array(
        'methods'             => 'POST',
        'callback'            => 'inti_bridge_patch',
        'permission_callback' => 'inti_bridge_can_edit',
        'args'                => array_merge($post_args, array(
            'blocks_field' => array('required' => true, 'type' => 'string'),
            'block_index'  => array('required' => true, 'type' => 'integer'),
            'field'        => array('required' => true, 'type' => 'string'),
            'value'        => array('required' => true),
        )),
    ));

    register_rest_route('inti/v1', '/rows', array(
        'methods'             => 'POST',
        'callback'            => 'inti_bridge_rows',
        'permission_callback' => 'inti_bridge_can_edit',
        'args'                => array_merge($post_args, array(
            'blocks_field' => array('required' => true, 'type' => 'string'),
            'op'           => array('required' => true, 'type' => 'string', 'enum' => array('move', 'insert', 'remove', 'duplicate', 'replace')),
            'from'         => array('type' => 'integer'),
            'to'           => array('type' => 'integer'),
            'index'        => array('type' => 'integer'),
            'rows'         => array('type' => 'array'),
            'data'         => array('type' => 'object'),
        )),
    ));

    // Kept for adapters older than 0.2: same as /rows with op=move
    register_rest_route('inti/v1', '/move', array(
        'methods'             => 'POST',
        'callback'            => function (WP_REST_Request $request) {
            $request->set_param('op', 'move');
            $request->set_param('from', $request->get_param('from_index'));
            $request->set_param('to', $request->get_param('to_index'));
            return inti_bridge_rows($request);
        },
        'permission_callback' => 'inti_bridge_can_edit',
    ));

    register_rest_route('inti/v1', '/content', array(
        'methods'             => 'POST',
        'callback'            => 'inti_bridge_content',
        'permission_callback' => 'inti_bridge_can_edit',
        'args'                => array_merge($post_args, array(
            'content' => array('required' => true, 'type' => 'string'),
        )),
    ));

    register_rest_route('inti/v1', '/menus/(?P<location>[a-zA-Z0-9_-]+)', array(
        'methods'             => 'GET',
        'callback'            => 'inti_bridge_menu',
        // What a theme location shows is public: it is in every page's HTML
        'permission_callback' => '__return_true',
    ));

    register_rest_route('inti/v1', '/status', array(
        'methods'             => 'GET',
        'callback'            => function () {
            return rest_ensure_response(array(
                'version'   => INTI_BRIDGE_VERSION,
                'acf'       => function_exists('update_field'),
                'purge'     => (bool) inti_bridge_purge_target(),
                'languages' => inti_bridge_language_plugin(),
                'abilities' => function_exists('wp_register_ability'),
            ));
        },
        'permission_callback' => function () {
            return current_user_can('edit_posts');
        },
    ));

    inti_bridge_register_fields();
});

// ============================================
// Atomic PATCH
// ============================================

/**
 * Updates a field with ACF's PHP API — atomic, no round-trip.
 *
 * block_index >= 0 → subfield of a Flexible Content row
 * block_index == -1 → page-level update_field
 *
 * `field` is the same dot-path the rest of Inti uses, with indexes from 0:
 * 'cta.label' in a group, 'items.1.title' in a repeater.
 */
function inti_bridge_patch(WP_REST_Request $request) {
    if (!function_exists('update_field')) {
        return inti_bridge_no_acf();
    }

    $post_id      = (int) $request->get_param('post_id');
    $blocks_field = sanitize_key($request->get_param('blocks_field'));
    $block_index  = (int) $request->get_param('block_index');
    $field        = (string) $request->get_param('field');
    $value        = $request->get_param('value');
    $field_parts  = explode('.', $field);

    foreach ($field_parts as $part) {
        if ($part === '' || in_array($part, array('__proto__', 'constructor', 'prototype'), true)) {
            return new WP_Error('inti_bad_path', "Invalid field path: {$field}", array('status' => 400));
        }
    }

    $conflict = inti_bridge_check_version($request, $post_id);
    if ($conflict) {
        return $conflict;
    }

    if ($block_index === -1) {
        // Page-level field. A dot-path goes into a group: update_field takes no
        // path, so the group is read, the key set, and the group written whole.
        $root = $field_parts[0];
        if (!get_field_object($root, $post_id, false, false)) {
            return new WP_Error('inti_unknown_field', "Field {$root} does not exist on this page", array('status' => 422));
        }
        if (count($field_parts) === 1) {
            update_field($root, $value, $post_id);
        } else {
            $current = get_field($root, $post_id);
            $current = is_array($current) ? $current : array();
            $cursor  = &$current;
            foreach (array_slice($field_parts, 1, -1) as $part) {
                if (!isset($cursor[$part]) || !is_array($cursor[$part])) {
                    $cursor[$part] = array();
                }
                $cursor = &$cursor[$part];
            }
            $cursor[end($field_parts)] = $value;
            unset($cursor);
            update_field($root, $current, $post_id);
        }
    } else {
        // A post without Flexible Content (Gutenberg) has no row: the adapter writes its content instead
        $order = get_post_meta($post_id, $blocks_field, true);
        if (!is_array($order) || !get_field_object($blocks_field, $post_id, false, false)) {
            return new WP_Error('inti_no_rows', "Post {$post_id} has no {$blocks_field} rows", array('status' => 422));
        }
        $leaf = inti_bridge_resolve_leaf($blocks_field, $block_index, $field_parts, $post_id);
        if (!$leaf) {
            return new WP_Error('inti_unknown_field', "Field {$field} does not exist on block {$block_index}", array('status' => 422));
        }
        acf_update_value($value, $post_id, $leaf);
    }

    return inti_bridge_written($post_id, array('field' => $field));
}

/**
 * Resolves a dot-path to the ACF field that stores that value, with the exact
 * meta name (`content_blocks_1_items_0_title`).
 *
 * update_sub_field is not used: its selectors number rows from 1 and do not
 * go through groups, so it wrote to another repeater item, rejected
 * 'cta.label' and accepted a nonexistent field, leaving an orphan meta.
 */
function inti_bridge_resolve_leaf($blocks_field, $block_index, $field_parts, $post_id) {
    $definition = get_field_object($blocks_field, $post_id, false, false);
    $order      = get_post_meta($post_id, $blocks_field, true);

    if (!$definition || !is_array($order) || !isset($order[$block_index])) {
        return null;
    }

    $sub_fields = null;
    foreach ($definition['layouts'] ?? array() as $layout) {
        if ($layout['name'] === $order[$block_index]) {
            $sub_fields = $layout['sub_fields'];
        }
    }
    if ($sub_fields === null) {
        return null;
    }

    $meta_name = "{$blocks_field}_{$block_index}";
    $leaf      = null;

    foreach ($field_parts as $part) {
        if (ctype_digit($part)) {
            // A repeater row: it must already exist
            $rows = (int) get_post_meta($post_id, $meta_name, true);
            if (!$leaf || $leaf['type'] !== 'repeater' || (int) $part >= $rows) {
                return null;
            }
            $meta_name .= "_{$part}";
            continue;
        }

        $leaf = null;
        foreach ($sub_fields as $candidate) {
            if ($candidate['name'] === $part) {
                $leaf = $candidate;
            }
        }
        if (!$leaf) {
            return null;
        }

        $meta_name .= "_{$part}";
        $sub_fields = $leaf['sub_fields'] ?? array();
    }

    // A whole group or repeater is not a value that can be written this way
    if (!$leaf || in_array($leaf['type'], array('group', 'repeater', 'flexible_content'), true)) {
        return null;
    }

    $leaf['name'] = $meta_name;
    return $leaf;
}

// ============================================
// Rows: structural edits, server side
// ============================================

/**
 * Moves, inserts, removes, duplicates or replaces Flexible Content rows in
 * one PHP call on the raw (unformatted) values.
 *
 * The REST alternative reads the whole array formatted, edits it in the
 * adapter and posts it back: two writers at once lose one edit, and image
 * fields travel as objects that have to be turned back into ids. Here the
 * array never leaves the server.
 *
 * New rows (`insert`, `replace`) carry sub field names; ACF accepts names and
 * keys in the same row.
 */
function inti_bridge_rows(WP_REST_Request $request) {
    if (!function_exists('update_field')) {
        return inti_bridge_no_acf();
    }

    $post_id      = (int) $request->get_param('post_id');
    $blocks_field = sanitize_key($request->get_param('blocks_field'));
    $op           = (string) $request->get_param('op');

    $conflict = inti_bridge_check_version($request, $post_id);
    if ($conflict) {
        return $conflict;
    }

    if (!get_field_object($blocks_field, $post_id, false, false)) {
        return new WP_Error('inti_no_rows', "Field {$blocks_field} is not a flexible content field", array('status' => 422));
    }
    $rows = get_field($blocks_field, $post_id, false);
    if ($rows === null || $rows === false || $rows === '') {
        $rows = array();
    }
    if (!is_array($rows)) {
        return new WP_Error('inti_no_rows', "Field {$blocks_field} is not a flexible content field", array('status' => 422));
    }
    $rows  = array_values($rows);
    $count = count($rows);
    $range = function ($i, $max) {
        return is_int($i) && $i >= 0 && $i < $max;
    };
    $out_of_range = new WP_Error('inti_out_of_range', 'Block index out of range (0-' . ($count - 1) . ')', array('status' => 422));

    switch ($op) {
        case 'move':
            $from = (int) $request->get_param('from');
            $to   = (int) $request->get_param('to');
            if (!$range($from, $count) || !$range($to, $count)) {
                return $out_of_range;
            }
            $moved = array_splice($rows, $from, 1);
            array_splice($rows, $to, 0, $moved);
            break;

        case 'insert':
            $new = $request->get_param('rows');
            if (!is_array($new) || count($new) === 0) {
                return new WP_Error('inti_no_rows', 'Nothing to insert', array('status' => 400));
            }
            foreach ($new as $row) {
                if (!is_array($row) || empty($row['acf_fc_layout'])) {
                    return new WP_Error('inti_bad_row', 'Every new row needs acf_fc_layout', array('status' => 400));
                }
            }
            $index = max(0, min((int) $request->get_param('index'), $count));
            array_splice($rows, $index, 0, $new);
            break;

        case 'remove':
            $index = (int) $request->get_param('index');
            if (!$range($index, $count)) {
                return $out_of_range;
            }
            array_splice($rows, $index, 1);
            break;

        case 'duplicate':
            $index = (int) $request->get_param('index');
            if (!$range($index, $count)) {
                return $out_of_range;
            }
            array_splice($rows, $index + 1, 0, array($rows[$index]));
            break;

        case 'replace':
            $index = (int) $request->get_param('index');
            $data  = $request->get_param('data');
            if (!$range($index, $count) || !is_array($data)) {
                return $out_of_range;
            }
            $rows[$index] = array_merge($data, array('acf_fc_layout' => $rows[$index]['acf_fc_layout']));
            break;
    }

    // update_field also returns false when the layout order did not change (rows of one
    // layout moved, a replaced row): the sub values were written all the same
    update_field($blocks_field, $rows, $post_id);

    return inti_bridge_written($post_id, array('op' => $op, 'count' => count($rows)));
}

// ============================================
// Content (Gutenberg)
// ============================================

function inti_bridge_content(WP_REST_Request $request) {
    $post_id = (int) $request->get_param('post_id');

    $conflict = inti_bridge_check_version($request, $post_id);
    if ($conflict) {
        return $conflict;
    }

    $result = wp_update_post(
        array('ID' => $post_id, 'post_content' => wp_slash((string) $request->get_param('content'))),
        true
    );
    if (is_wp_error($result)) {
        $result->add_data(array('status' => 422));
        return $result;
    }

    clean_post_cache($post_id);
    return rest_ensure_response(array('success' => true, 'post_id' => $post_id, 'modified_gmt' => inti_bridge_modified($post_id), 'atomic' => true));
}

// ============================================
// REST fields: blocks, language, translations
// ============================================

function inti_bridge_register_fields() {
    $types = get_post_types(array('show_in_rest' => true), 'names');

    foreach ($types as $type) {
        if (in_array($type, array('attachment', 'wp_block', 'wp_template', 'wp_template_part', 'wp_navigation', 'nav_menu_item', 'wp_global_styles', 'wp_font_family', 'wp_font_face'), true)) {
            continue;
        }

        if (post_type_supports($type, 'editor')) {
            register_rest_field($type, 'inti_blocks', array(
                'get_callback' => function ($post) {
                    return inti_bridge_blocks(get_post($post['id']));
                },
                'schema' => array('type' => 'array', 'context' => array('view', 'edit'), 'readonly' => true),
            ));
        }

        register_rest_field($type, 'inti_locale', array(
            'get_callback' => function ($post) {
                return inti_bridge_locale_of((int) $post['id']);
            },
            'schema' => array('type' => array('string', 'null'), 'context' => array('view', 'edit'), 'readonly' => true),
        ));

        register_rest_field($type, 'inti_translations', array(
            'get_callback' => function ($post) {
                return inti_bridge_translations_of((int) $post['id']);
            },
            'schema' => array('type' => 'array', 'context' => array('view', 'edit'), 'readonly' => true),
        ));
    }
}

/**
 * The post's top-level blocks as `parse_blocks()` reads `post_content` (the
 * stored content: blocks a Block Hook inserts at render time are not in it,
 * so positions match what a write changes).
 *
 * Blank freeform chunks between blocks are skipped, as the adapter's own
 * parser does. A block bound to a source (`metadata.bindings`) or rendered
 * by PHP (a dynamic block) also carries `rendered`: what it shows is not in
 * `post_content`.
 */
function inti_bridge_blocks($post) {
    if (!$post || !has_blocks($post->post_content)) {
        return array();
    }

    $registry = WP_Block_Type_Registry::get_instance();
    $out      = array();

    foreach (parse_blocks($post->post_content) as $block) {
        if (empty($block['blockName'])) {
            continue;
        }

        $type     = $registry->get_registered($block['blockName']);
        $bound    = !empty($block['attrs']['metadata']['bindings']);
        $dynamic  = $type && $type->is_dynamic();
        $rendered = null;

        if ($bound || $dynamic) {
            // render_block resolves bindings (WordPress 6.5+) with this post as context
            $previous        = $GLOBALS['post'] ?? null;
            $GLOBALS['post'] = $post;
            setup_postdata($post);
            $rendered = render_block($block);
            $GLOBALS['post'] = $previous;
            wp_reset_postdata();
        }

        $out[] = array(
            'name'      => $block['blockName'],
            'attrs'     => (object) $block['attrs'],
            'innerHTML' => $block['innerHTML'],
            'bound'     => $bound,
            'dynamic'   => (bool) $dynamic,
            'rendered'  => $rendered,
        );
    }

    return $out;
}

/** 'polylang', 'wpml' or null */
function inti_bridge_language_plugin() {
    if (function_exists('pll_get_post_language')) {
        return 'polylang';
    }
    if (defined('ICL_SITEPRESS_VERSION')) {
        return 'wpml';
    }
    return null;
}

/** BCP 47 code of the post's language, or null when the site has one language */
function inti_bridge_locale_of($post_id) {
    switch (inti_bridge_language_plugin()) {
        case 'polylang':
            $slug = pll_get_post_language($post_id, 'slug');
            return $slug ?: null;
        case 'wpml':
            $details = apply_filters('wpml_post_language_details', null, $post_id);
            return is_array($details) && !empty($details['language_code']) ? $details['language_code'] : null;
    }
    return null;
}

/** The other languages of the post: [{ locale, slug, url, id }] */
function inti_bridge_translations_of($post_id) {
    $ids = array();

    switch (inti_bridge_language_plugin()) {
        case 'polylang':
            $ids = pll_get_post_translations($post_id);
            break;
        case 'wpml':
            $type    = apply_filters('wpml_element_type', get_post_type($post_id));
            $trid    = apply_filters('wpml_element_trid', null, $post_id, $type);
            $entries = $trid ? apply_filters('wpml_get_element_translations', null, $trid, $type) : array();
            foreach ((array) $entries as $code => $entry) {
                if (!empty($entry->element_id)) {
                    $ids[$code] = (int) $entry->element_id;
                }
            }
            break;
    }

    $out = array();
    foreach ($ids as $locale => $id) {
        if ((int) $id === (int) $post_id || get_post_status($id) !== 'publish') {
            continue;
        }
        $out[] = array('locale' => $locale, 'slug' => inti_bridge_path($id), 'url' => get_permalink($id), 'id' => (int) $id);
    }
    return $out;
}

// ============================================
// Menus
// ============================================

/**
 * The menu of a theme location as a tree: [{ label, url, path, target, children }].
 * `path` is relative to the site, for the Astro site to link to its own route.
 * `?lang=` picks the location's menu in that language (Polylang, WPML).
 */
function inti_bridge_menu(WP_REST_Request $request) {
    $location  = $request->get_param('location');
    $locations = get_nav_menu_locations();
    $lang      = $request->get_param('lang');

    if ($lang && inti_bridge_language_plugin() === 'polylang' && function_exists('pll_languages_list')) {
        $options = get_option('polylang');
        $menu_id = $options['nav_menus'][get_stylesheet()][$location][$lang] ?? null;
    } else {
        if ($lang) {
            do_action('wpml_switch_language', $lang);
        }
        $menu_id = $locations[$location] ?? null;
    }

    if (!$menu_id) {
        return new WP_Error('inti_no_menu', "No menu is assigned to \"{$location}\"", array('status' => 404));
    }

    $items = wp_get_nav_menu_items($menu_id, array('update_post_term_cache' => false));
    if (!is_array($items)) {
        return rest_ensure_response(array('items' => array()));
    }

    $home  = untrailingslashit(home_url());
    $nodes = array();
    foreach ($items as $item) {
        $url  = $item->url;
        $path = strpos($url, $home) === 0 ? (substr($url, strlen($home)) ?: '/') : null;
        $nodes[(int) $item->ID] = array(
            'label'    => html_entity_decode($item->title, ENT_QUOTES),
            'url'      => $url,
            'path'     => $path,
            'target'   => $item->target ?: null,
            'parent'   => (int) $item->menu_item_parent,
            'children' => array(),
        );
    }

    $tree = array();
    foreach ($nodes as $id => &$node) {
        if ($node['parent'] && isset($nodes[$node['parent']])) {
            $nodes[$node['parent']]['children'][] = &$node;
        } else {
            $tree[] = &$node;
        }
    }
    unset($node);

    $clean = function ($list) use (&$clean) {
        return array_map(function ($node) use ($clean) {
            unset($node['parent']);
            $node['children'] = $clean($node['children']);
            return $node;
        }, $list);
    };

    return rest_ensure_response(array('location' => $location, 'items' => $clean($tree)));
}

// ============================================
// Purge notices
// ============================================

/** [url, secret] or null when not configured */
function inti_bridge_purge_target() {
    $url    = defined('INTI_PURGE_URL') ? INTI_PURGE_URL : get_option('inti_purge_url');
    $secret = defined('INTI_PURGE_SECRET') ? INTI_PURGE_SECRET : get_option('inti_purge_secret');
    return $url && $secret ? array($url, $secret) : null;
}

/** Notices collected during the request, sent once at the end */
$GLOBALS['inti_bridge_pending_purges'] = array();

function inti_bridge_queue_purge($post_id, $event, $slug = null) {
    $post = get_post($post_id);
    if (!$post || wp_is_post_revision($post) || wp_is_post_autosave($post)) {
        return;
    }
    if (strpos((string) $post->post_name, 'inti-draft-of-') === 0 || $post->post_type === 'nav_menu_item') {
        return;
    }
    $key = $post_id . ':' . $event;
    $GLOBALS['inti_bridge_pending_purges'][$key] = array(
        'event' => $event,
        'id'    => (int) $post_id,
        'type'  => $post->post_type,
        'slug'  => $slug ?? inti_bridge_path($post),
    );
}

/**
 * A published post changed, stopped being published, or was deleted.
 * Drafts and private posts are not on the site: no notice.
 */
add_action('transition_post_status', function ($new, $old, $post) {
    if ($new === 'publish') {
        inti_bridge_queue_purge($post->ID, 'post.updated');
    } elseif ($old === 'publish') {
        inti_bridge_queue_purge($post->ID, $new === 'trash' ? 'post.deleted' : 'post.unpublished');
    }
}, 10, 3);

/** A slug change: the old address must go too */
add_action('post_updated', function ($post_id, $after, $before) {
    if ($before->post_status === 'publish' && $before->post_name !== $after->post_name) {
        inti_bridge_queue_purge($post_id, 'post.deleted', inti_bridge_path($before) ?: $before->post_name);
    }
}, 10, 3);

/** wp-admin saves ACF fields after the post: the post date may not change */
add_action('acf/save_post', function ($post_id) {
    if (is_numeric($post_id) && get_post_status($post_id) === 'publish') {
        inti_bridge_queue_purge((int) $post_id, 'post.updated');
    }
}, 20);

add_action('before_delete_post', function ($post_id) {
    if (get_post_status($post_id) === 'publish') {
        inti_bridge_queue_purge($post_id, 'post.deleted');
    }
});

/** A menu change touches every page */
add_action('wp_update_nav_menu', function () {
    $GLOBALS['inti_bridge_pending_purges']['menu'] = array('event' => 'menu.updated', 'all' => true);
});

add_action('shutdown', function () {
    $pending = $GLOBALS['inti_bridge_pending_purges'];
    $target  = inti_bridge_purge_target();
    if (!$pending || !$target) {
        return;
    }
    list($url, $secret) = $target;

    // The response to wp-admin is already sent when PHP-FPM allows it; then waiting costs nobody
    $finished = function_exists('fastcgi_finish_request') && fastcgi_finish_request();
    // A CLI or cron process exits right after: a request it does not wait for is never sent
    $blocking = $finished || (defined('WP_CLI') && WP_CLI) || wp_doing_cron();

    foreach ($pending as $notice) {
        $body = wp_json_encode($notice);
        wp_remote_post($url, array(
            'blocking' => $blocking,
            'timeout'  => 2,
            'headers'  => array(
                'Content-Type'     => 'application/json',
                'X-Inti-Signature' => 'sha256=' . hash_hmac('sha256', $body, $secret),
            ),
            'body'     => $body,
        ));
    }
    $GLOBALS['inti_bridge_pending_purges'] = array();
});

// ============================================
// Abilities API (WordPress 6.9+)
// ============================================

/**
 * What an AI agent in WordPress can do with Inti's content: read a page's
 * blocks, change one field, and empty the site's cache for a page. Each one
 * checks the same capability a person would need.
 */
add_action('wp_abilities_api_categories_init', function () {
    if (function_exists('wp_register_ability_category')) {
        wp_register_ability_category('inti', array(
            'label'       => 'Inti',
            'description' => 'Content of the Astro site rendered by Inti.',
        ));
    }
});

add_action('wp_abilities_api_init', function () {
    if (!function_exists('wp_register_ability')) {
        return;
    }

    wp_register_ability('inti/get-page', array(
        'label'               => 'Read a page and its blocks',
        'description'         => 'Returns the page with that path, its blocks and its modification date.',
        'category'            => 'inti',
        'input_schema'        => array(
            'type'       => 'object',
            'properties' => array('path' => array('type' => 'string')),
            'required'   => array('path'),
        ),
        'output_schema'       => array('type' => 'object'),
        'permission_callback' => function () {
            return current_user_can('read');
        },
        'execute_callback'    => function ($input) {
            $post = get_page_by_path(trim($input['path'], '/'), OBJECT, get_post_types(array('public' => true)));
            if (!$post || ($post->post_status !== 'publish' && !current_user_can('edit_post', $post->ID))) {
                return new WP_Error('inti_not_found', 'No such page', array('status' => 404));
            }
            return array(
                'id'           => $post->ID,
                'path'         => inti_bridge_path($post),
                'title'        => get_the_title($post),
                'modified_gmt' => inti_bridge_modified($post->ID),
                'blocks'       => function_exists('get_field') && get_field('content_blocks', $post->ID) ? get_field('content_blocks', $post->ID) : inti_bridge_blocks($post),
            );
        },
        'meta'                => array('annotations' => array('readonly' => true), 'show_in_rest' => true),
    ));

    wp_register_ability('inti/update-block-field', array(
        'label'               => 'Change one field of a block',
        'description'         => 'Writes one field of a Flexible Content row, refusing when the page changed since `expected_modified`.',
        'category'            => 'inti',
        'input_schema'        => array(
            'type'       => 'object',
            'properties' => array(
                'post_id'           => array('type' => 'integer'),
                'blocks_field'      => array('type' => 'string', 'default' => 'content_blocks'),
                'block_index'       => array('type' => 'integer'),
                'field'             => array('type' => 'string'),
                'value'             => array(),
                'expected_modified' => array('type' => 'string'),
            ),
            'required'   => array('post_id', 'block_index', 'field', 'value'),
        ),
        'output_schema'       => array('type' => 'object'),
        'permission_callback' => function ($input) {
            return current_user_can('edit_post', (int) ($input['post_id'] ?? 0));
        },
        'execute_callback'    => function ($input) {
            $request = new WP_REST_Request('POST', '/inti/v1/patch');
            foreach ($input as $key => $value) {
                $request->set_param($key, $value);
            }
            if (!$request->get_param('blocks_field')) {
                $request->set_param('blocks_field', 'content_blocks');
            }
            $response = inti_bridge_patch($request);
            return is_wp_error($response) ? $response : $response->get_data();
        },
        'meta'                => array('annotations' => array('destructive' => false, 'idempotent' => true), 'show_in_rest' => true),
    ));

    wp_register_ability('inti/purge', array(
        'label'               => 'Refresh a page on the site',
        'description'         => 'Asks the Astro site to drop its cached copy of a page, or of every page.',
        'category'            => 'inti',
        'input_schema'        => array(
            'type'       => 'object',
            'properties' => array('post_id' => array('type' => 'integer'), 'all' => array('type' => 'boolean')),
        ),
        'output_schema'       => array('type' => 'object'),
        'permission_callback' => function ($input) {
            return !empty($input['post_id']) ? current_user_can('edit_post', (int) $input['post_id']) : current_user_can('edit_others_posts');
        },
        'execute_callback'    => function ($input) {
            if (!inti_bridge_purge_target()) {
                return new WP_Error('inti_no_purge', 'INTI_PURGE_URL and INTI_PURGE_SECRET are not configured', array('status' => 501));
            }
            if (!empty($input['post_id'])) {
                inti_bridge_queue_purge((int) $input['post_id'], 'post.updated');
            } else {
                $GLOBALS['inti_bridge_pending_purges']['all'] = array('event' => 'manual', 'all' => true);
            }
            return array('queued' => true);
        },
        'meta'                => array('annotations' => array('destructive' => false, 'idempotent' => true), 'show_in_rest' => true),
    ));
});

// ============================================
// WPGraphQL: optional mutation
// ============================================

/**
 * WPGraphQL for ACF does not support mutations upstream. This registers a
 * mutation that runs the same code as POST /inti/v1/patch.
 */
add_action('graphql_register_types', function () {
    if (!function_exists('register_graphql_mutation')) {
        return;
    }

    register_graphql_mutation('intiUpdateBlockField', array(
        'inputFields' => array(
            'postId'           => array('type' => array('non_null' => 'Int')),
            'blocksField'      => array('type' => array('non_null' => 'String')),
            'blockIndex'       => array('type' => array('non_null' => 'Int')),
            'field'            => array('type' => array('non_null' => 'String')),
            'value'            => array('type' => array('non_null' => 'String')),
            'expectedModified' => array('type' => 'String'),
        ),
        'outputFields' => array(
            'success'     => array('type' => 'Boolean'),
            'postId'      => array('type' => 'Int'),
            'modifiedGmt' => array('type' => 'String'),
        ),
        'mutateAndGetPayload' => function ($input) {
            $post_id = (int) $input['postId'];
            if (!current_user_can('edit_post', $post_id)) {
                throw new \GraphQL\Error\UserError('Not allowed to edit this post');
            }

            $request = new WP_REST_Request('POST', '/inti/v1/patch');
            $request->set_param('post_id', $post_id);
            $request->set_param('blocks_field', $input['blocksField']);
            $request->set_param('block_index', (int) $input['blockIndex']);
            $request->set_param('field', $input['field']);
            $request->set_param('value', $input['value']);
            $request->set_param('expected_modified', $input['expectedModified'] ?? null);

            $response = inti_bridge_patch($request);
            if (is_wp_error($response)) {
                throw new \GraphQL\Error\UserError($response->get_error_message());
            }
            $data = $response->get_data();
            return array('success' => true, 'postId' => $post_id, 'modifiedGmt' => $data['modified_gmt'] ?? null);
        },
    ));
});
