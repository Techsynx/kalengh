const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
    packagerConfig: {
        asar: {
            unpack: '**/{onnxruntime-node,onnxruntime-common,@huggingface/transformers,sharp,@img}/**',
        },
        extraResource: ['./src/assets/SystemAudioDump'],
        name: 'kalengh',
        icon: 'src/assets/logo',
    },
    rebuildConfig: {},
    makers: [
        {
            name: '@electron-forge/maker-squirrel',
            platforms: ['win32'],
            config: {
                name: 'kalengh',
                productName: 'kalengh',
                shortcutName: 'kalengh',
                createDesktopShortcut: true,
                createStartMenuShortcut: true,
            },
        },
        {
            name: '@electron-forge/maker-dmg',
            platforms: ['darwin'],
        },
        {
            name: '@electron-forge/maker-deb',
            platforms: ['linux'],
            config: {
                options: {
                    name: 'kalengh',
                    productName: 'kalengh',
                    description: 'kalengh — Real-time AI Assistant by exhuzaifa',
                    categories: ['Utility', 'Development'],
                    icon: 'src/assets/logo.png',
                },
            },
        },
        {
            name: '@electron-forge/maker-zip',
            platforms: ['darwin', 'linux'],
        },
    ],
    plugins: [
        {
            name: '@electron-forge/plugin-auto-unpack-natives',
            config: {},
        },
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }),
    ],
};
