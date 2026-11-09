<?php
/**
 * Plugin Name: Inti Bridge
 * Plugin URI: https://github.com/intijs/inti
 * Description: Companion plugin for Inti.js inline editing on Astro. Adds atomic ACF field patching via REST (no full-array round-trip) and an optional WPGraphQL mutation.
 * Version: 0.1.0
 * Requires at least: 5.6
 * Requires PHP: 7.4
 * Author: Victor Antinori Broce
 * License: MIT
 *
 * Endpoints:
 *   POST /wp-json/inti/v1/patch  — atomic field patch (page-level or flexible content row)
 *   POST /wp-json/inti/v1/move   — reorder a flexible content row
 *
 * Both require an authenticated user with edit permission on the post
 * (Application Passwords work out of the box).
 *
 * If WPGraphQL is active, an `intiUpdateBlockField` mutation is also
 * registered (WPGraphQL for ACF does not ship mutations upstream).
 */

if (!defined('ABSPATH')) {
    exit;
}

// ============================================
// REST: route registration
// ============================================

add_action('rest_api_init', function () {
    register_rest_route('inti/v1', '/patch', array(
        'methods'             => 'POST',
        'callback'            => 'inti_bridge_patch',
        'permission_callback' => 'inti_bridge_can_edit',
        'args'                => array(
            'post_id'      => array('required' => true, 'type' => 'integer'),
            'blocks_field' => array('required' => true, 'type' => 'string'),
            'block_index'  => array('required' => true, 'type' => 'integer'),
            'field'        => array('required' => true, 'type' => 'string'),
            'value'        => array('required' => true),
        ),
    ));

    register_rest_route('inti/v1', '/move', array(
        'methods'             => 'POST',
        'callback'            => 'inti_bridge_move',
        'permission_callback' => 'inti_bridge_can_edit',
        'args'                => array(
            'post_id'      => array('required' => true, 'type' => 'integer'),
            'blocks_field' => array('required' => true, 'type' => 'string'),
            'from_index'   => array('required' => true, 'type' => 'integer'),
            'to_index'     => array('required' => true, 'type' => 'integer'),
        ),
    ));
});

/**
 * Permission: the authenticated user must be able to edit the target post
 */
function inti_bridge_can_edit(WP_REST_Request $request) {
    $post_id = (int) $request->get_param('post_id');
    return $post_id > 0 && current_user_can('edit_post', $post_id);
}

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
        return new WP_Error('inti_no_acf', 'ACF is not active on this site', array('status' => 501));
    }

    $post_id      = (int) $request->get_param('post_id');
    $blocks_field = sanitize_key($request->get_param('blocks_field'));
    $block_index  = (int) $request->get_param('block_index');
    $field        = (string) $request->get_param('field');
    $value        = $request->get_param('value');
    $field_parts  = explode('.', $field);

    if ($block_index === -1) {
        // Page-level field
        $selector = count($field_parts) === 1 ? $field_parts[0] : array_map('sanitize_key', $field_parts);
        $ok = update_field($selector, $value, $post_id);

        // ACF also returns false when the value did not change; tell them apart
        if (!$ok && get_field($field_parts[0], $post_id) != $value) {
            return new WP_Error('inti_patch_failed', 'ACF rejected the update (field not found?)', array('status' => 422));
        }
    } else {
        $leaf = inti_bridge_resolve_leaf($blocks_field, $block_index, $field_parts, $post_id);
        if (!$leaf) {
            return new WP_Error('inti_unknown_field', "Field {$field} does not exist on block {$block_index}", array('status' => 422));
        }
        acf_update_value($value, $post_id, $leaf);
    }

    return rest_ensure_response(array(
        'success'  => true,
        'post_id'  => $post_id,
        'field'    => $field,
        'atomic'   => true,
    ));
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
// Row MOVE
// ============================================

/**
 * Reorders a Flexible Content row.
 * (ACF has no reorder primitive: the field's array is rewritten,
 * but server-side and in a single operation.)
 */
function inti_bridge_move(WP_REST_Request $request) {
    if (!function_exists('update_field')) {
        return new WP_Error('inti_no_acf', 'ACF is not active on this site', array('status' => 501));
    }

    $post_id      = (int) $request->get_param('post_id');
    $blocks_field = sanitize_key($request->get_param('blocks_field'));
    $from         = (int) $request->get_param('from_index');
    $to           = (int) $request->get_param('to_index');

    $rows = get_field($blocks_field, $post_id, false); // false = raw values (unformatted)

    if (!is_array($rows)) {
        return new WP_Error('inti_no_rows', "Field {$blocks_field} is not a flexible content field", array('status' => 422));
    }

    $count = count($rows);
    if ($from < 0 || $from >= $count || $to < 0 || $to >= $count) {
        return new WP_Error('inti_out_of_range', "Move indexes out of range (0-" . ($count - 1) . ")", array('status' => 422));
    }

    $moved = array_splice($rows, $from, 1);
    array_splice($rows, $to, 0, $moved);

    $ok = update_field($blocks_field, $rows, $post_id);

    if (!$ok) {
        return new WP_Error('inti_move_failed', 'ACF rejected the reorder', array('status' => 422));
    }

    return rest_ensure_response(array(
        'success' => true,
        'post_id' => $post_id,
        'from'    => $from,
        'to'      => $to,
    ));
}

// ============================================
// WPGraphQL: optional mutation
// ============================================

/**
 * WPGraphQL for ACF does not support mutations upstream (blocked by the
 * GraphQL spec's @oneOf directive). This plugin registers a generic
 * mutation equivalent to the /patch endpoint for those who prefer GraphQL.
 */
add_action('graphql_register_types', function () {
    if (!function_exists('register_graphql_mutation')) {
        return;
    }

    register_graphql_mutation('intiUpdateBlockField', array(
        'inputFields' => array(
            'postId'      => array('type' => array('non_null' => 'Int')),
            'blocksField' => array('type' => array('non_null' => 'String')),
            'blockIndex'  => array('type' => array('non_null' => 'Int')),
            'field'       => array('type' => array('non_null' => 'String')),
            'value'       => array('type' => array('non_null' => 'String')),
        ),
        'outputFields' => array(
            'success' => array('type' => 'Boolean'),
            'postId'  => array('type' => 'Int'),
        ),
        'mutateAndGetPayload' => function ($input) {
            $post_id = (int) $input['postId'];

            if (!current_user_can('edit_post', $post_id)) {
                throw new \GraphQL\Error\UserError('Not allowed to edit this post');
            }
            if (!function_exists('update_sub_field')) {
                throw new \GraphQL\Error\UserError('ACF is not active');
            }

            $field_parts = array_map('sanitize_key', explode('.', $input['field']));
            $block_index = (int) $input['blockIndex'];

            if ($block_index === -1) {
                $selector = count($field_parts) === 1 ? $field_parts[0] : $field_parts;
                update_field($selector, $input['value'], $post_id);
            } else {
                $selector = array_merge(
                    array(sanitize_key($input['blocksField']), $block_index + 1),
                    $field_parts
                );
                update_sub_field($selector, $input['value'], $post_id);
            }

            return array('success' => true, 'postId' => $post_id);
        },
    ));
});
