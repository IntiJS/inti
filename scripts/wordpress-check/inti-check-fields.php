<?php
/**
 * Plugin Name: Inti check fields
 * Description: The block model of a typical site: Flexible Content exposed over REST.
 *
 * Secure Custom Fields implements the same API as ACF, Flexible Content
 * included, without a license: that way the check can run on any
 * machine and in CI.
 */

add_action('acf/init', function () {
    acf_add_local_field_group([
        'key' => 'group_inti_check',
        'title' => 'Blocks',
        'show_in_rest' => true,
        'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'page']]],
        'fields' => [
            [
                'key' => 'field_inti_blocks',
                'label' => 'Blocks',
                'name' => 'content_blocks',
                'type' => 'flexible_content',
                'layouts' => [
                    'layout_hero' => [
                        'key' => 'layout_hero',
                        'name' => 'hero_banner',
                        'label' => 'Hero',
                        'sub_fields' => [
                            ['key' => 'field_hero_heading', 'label' => 'Heading', 'name' => 'heading', 'type' => 'text'],
                            // Fields that return something other than what they accept: a
                            // naive read-modify-write would break them when saving a neighbor
                            ['key' => 'field_hero_image', 'label' => 'Image', 'name' => 'image', 'type' => 'image', 'return_format' => 'array'],
                            ['key' => 'field_hero_gallery', 'label' => 'Gallery', 'name' => 'gallery', 'type' => 'gallery', 'return_format' => 'array'],
                            ['key' => 'field_hero_related', 'label' => 'Related', 'name' => 'related', 'type' => 'relationship', 'post_type' => ['page'], 'return_format' => 'object'],
                            ['key' => 'field_hero_link', 'label' => 'Link', 'name' => 'link', 'type' => 'link', 'return_format' => 'array'],
                            ['key' => 'field_hero_body', 'label' => 'Body', 'name' => 'body', 'type' => 'wysiwyg'],
                            ['key' => 'field_hero_enabled', 'label' => 'Enabled', 'name' => 'enabled', 'type' => 'true_false'],
                            ['key' => 'field_hero_variant', 'label' => 'Variant', 'name' => 'variant', 'type' => 'select', 'choices' => ['dark' => 'Dark', 'light' => 'Light']],
                            [
                                'key' => 'field_hero_cta',
                                'label' => 'CTA',
                                'name' => 'cta',
                                'type' => 'group',
                                'sub_fields' => [
                                    ['key' => 'field_hero_cta_label', 'label' => 'Label', 'name' => 'label', 'type' => 'text'],
                                    ['key' => 'field_hero_cta_url', 'label' => 'URL', 'name' => 'url', 'type' => 'url'],
                                ],
                            ],
                        ],
                    ],
                    'layout_features' => [
                        'key' => 'layout_features',
                        'name' => 'feature_list',
                        'label' => 'Features',
                        'sub_fields' => [
                            ['key' => 'field_features_title', 'label' => 'Title', 'name' => 'title', 'type' => 'text'],
                            [
                                'key' => 'field_features_items',
                                'label' => 'Items',
                                'name' => 'items',
                                'type' => 'repeater',
                                'sub_fields' => [
                                    ['key' => 'field_item_title', 'label' => 'Title', 'name' => 'title', 'type' => 'text'],
                                    ['key' => 'field_item_body', 'label' => 'Body', 'name' => 'body', 'type' => 'textarea'],
                                ],
                            ],
                        ],
                    ],
                ],
            ],
        ],
    ]);
});
