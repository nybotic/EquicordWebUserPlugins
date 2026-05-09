EquicordUserPlugins.register({
    name: "Example User Plugin",
    start({ api, cleanup }) {
        api.toast("Example User Plugin started", "SUCCESS");

        const onKeyDown = event => {
            if (event.ctrlKey && event.shiftKey && event.code === "KeyE") {
                api.toast("Example hotkey pressed", "SUCCESS");
            }
        };

        window.addEventListener("keydown", onKeyDown, true);
        cleanup(() => window.removeEventListener("keydown", onKeyDown, true));
    },
    stop({ api }) {
        api.toast("Example User Plugin stopped", "MESSAGE");
    }
});
