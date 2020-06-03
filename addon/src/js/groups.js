(function() {
    'use strict';

    // if set groupId => return [group, groups, groupIndex]
    async function load(groupId = null, withTabs = false, includeFavIconUrl, includeThumbnail) {
        let [allTabs, {groups}] = await Promise.all([
            withTabs ? Tabs.get(null, false, null, undefined, includeFavIconUrl, includeThumbnail) : false,
            storage.get('groups')
        ]);

        if (withTabs) {
            let groupTabs = {};

            groups.forEach(group => groupTabs[group.id] = []);

            await Promise.all(allTabs.map(async function(tab) {
                if (tab.groupId) {
                    if (groupTabs[tab.groupId]) {
                        groupTabs[tab.groupId].push(tab);
                    } else {
                        delete tab.groupId;
                        await cache.removeTabGroup(tab.id);
                    }
                }
            }));

            groups = groups.map(function(group) {
                if (!group.isArchive) {
                    group.tabs = groupTabs[group.id].sort(utils.sortBy('index'));
                }

                return group;
            });
        }

        if (groupId) {
            return [groups.find(group => group.id === groupId), groups, groups.findIndex(group => group.id === groupId)];
        }

        return groups;
    }

    async function save(groups, withMessage = false) {
        if (!Array.isArray(groups)) {
            throw Error('groups has invalid type');
        }

        await storage.set({
            groups,
        });

        if (isNeedBlockBeforeRequest(groups)) {
            BG.addListenerOnBeforeRequest();
        } else {
            BG.removeListenerOnBeforeRequest();
        }

        if (withMessage) {
            BG.sendMessage({
                action: 'groups-updated',
            });
        }

        return groups;
    }

    function create(id, title) {
        return {
            id: id,
            title: utils.createGroupTitle(title, id),
            iconColor: BG.options.defaultGroupIconColor || utils.randomColor(),
            iconUrl: null,
            iconViewType: BG.options.defaultGroupIconViewType,
            tabs: [],
            isArchive: false,
            newTabContainer: DEFAULT_COOKIE_STORE_ID,
            ifDifferentContainerReOpen: false,
            excludeContainersForReOpen: [],
            isMain: false,
            isSticky: false,
            catchTabContainers: [],
            catchTabRules: '',
            moveToMainIfNotInCatchTabRules: false,
            muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
            showTabAfterMovingItIntoThisGroup: false,
            dontDiscardTabsAfterHideThisGroup: false,
        };
    }

    async function add(windowId, tabIds = [], title = null, showTabsAfterMoving) {
        tabIds = Array.isArray(tabIds) ? tabIds.slice() : [];

        title = (typeof title === 'string' && title) ? title.slice(0, 256) : null;

        let {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition');

        lastCreatedGroupPosition++;

        let groups = await load();

        if (title && groups.some(gr => gr.title === title)) {
            utils.notify(browser.i18n.getMessage('groupWithSameNameExists'));
            title = null;
        }

        let newGroup = create(lastCreatedGroupPosition, title);

        groups.push(newGroup);

        await save(groups);

        await storage.set({
            lastCreatedGroupPosition,
        });

        if (windowId) {
            await cache.setWindowGroup(windowId, newGroup.id);
            BG.updateBrowserActionData(newGroup.id);
        }

        BG.updateMoveTabMenus();

        if (windowId && !tabIds.length) {
            let tabs = await Tabs.get(windowId);
            tabIds = tabs.map(utils.keyId);
        }

        if (tabIds.length) {
            newGroup.tabs = await Tabs.move(tabIds, newGroup.id, undefined, false, showTabsAfterMoving);
        }

        if (!showTabsAfterMoving) {
            BG.sendMessage({
                action: 'group-added',
                group: newGroup,
            });
        }

        BG.sendExternalMessage({
            action: 'group-added',
            group: mapForExternalExtension(newGroup),
        });

        return newGroup;
    }

    async function remove(groupId) {
        let [group, groups, index] = await load(groupId, true);

        BG.addUndoRemoveGroupItem(group);

        groups.splice(index, 1);

        await save(groups);

        if (!group.isArchive) {
            let groupWindowId = cache.getWindowId(groupId);

            if (groupWindowId) {
                BG.setBrowserAction(groupWindowId, 'loading');
                await cache.removeWindowSession(groupWindowId);
            }

            if (group.tabs.length) {
                if (groupWindowId) {
                    await Tabs.createTempActiveTab(groupWindowId, false);
                }

                await Tabs.remove(group.tabs.map(utils.keyId));
            }

            BG.updateMoveTabMenus();

            if (groupWindowId) {
                BG.updateBrowserActionData(null, groupWindowId);
            }

            if (group.isMain) {
                utils.notify(browser.i18n.getMessage('thisGroupWasMain'), 7000);
            }
        }

        BG.removeBookmarkGroup(group.title);

        BG.sendMessage({
            action: 'group-removed',
            groupId: groupId,
        });

        BG.sendExternalMessage({
            action: 'group-removed',
            groupId: groupId,
        });
    }

    async function update(groupId, updateData) {
        let [group, groups] = await load(groupId);

        if (!group) {
            throw Error(`group ${groupId} not found for update it`);
        }

        updateData = utils.clone(updateData); // clone need for fix bug: dead object after close tab which create object

        if (updateData.iconUrl && updateData.iconUrl.startsWith('chrome:')) {
            utils.notify('Icon not supported');
            delete updateData.iconUrl;
        }

        if (updateData.title) {
            updateData.title = updateData.title.slice(0, 256);

            if (groups.some(gr => gr.title === updateData.title)) {
                utils.notify(browser.i18n.getMessage('groupWithSameNameExists'));
                delete updateData.title;
            }
        }

        if (!Object.keys(updateData).length) {
            return;
        }

        if (updateData.isMain) {
            groups.forEach(gr => gr.isMain = gr.id === groupId);
        }

        let oldGroupTitle = group.title;

        Object.assign(group, updateData);

        await save(groups);

        BG.sendMessage({
            action: 'group-updated',
            group: {
                id: groupId,
                ...updateData,
            },
        });

        if (['title', 'iconUrl', 'iconColor', 'iconViewType', 'newTabContainer'].some(key => updateData.hasOwnProperty(key))) {
            BG.sendExternalMessage({
                action: 'group-updated',
                group: mapForExternalExtension(group),
            });

            BG.updateMoveTabMenus();

            BG.updateBrowserActionData(groupId);
        }

        if (updateData.hasOwnProperty('title')) {
            BG.updateBookmarkGroupTitle(oldGroupTitle, updateData.title);
        }
    }

    async function move(groupId, newGroupIndex) {
        let [group, groups, groupIndex] = await load(groupId);

        groups.splice(newGroupIndex, 0, groups.splice(groupIndex, 1)[0]);

        await save(groups, true);

        BG.updateMoveTabMenus();
    }

    async function sort(vector = 'asc') {
        if (!['asc', 'desc'].includes(vector)) {
            throw Error(`invalid sort vector: ${vector}`);
        }

        let groups = await load();

        if ('asc' === vector) {
            groups.sort(utils.sortBy('title'));
        } else {
            groups.sort(utils.sortBy('title', undefined, true));
        }

        await save(groups, true);

        BG.updateMoveTabMenus();
    }

    async function unload(groupId) {
        if (!groupId) {
            utils.notify(browser.i18n.getMessage('groupNotFound'), 7000, 'groupNotFound');
            return false;
        }

        let windowId = cache.getWindowId(groupId);

        if (!windowId) {
            utils.notify(browser.i18n.getMessage('groupNotLoaded'), 7000, 'groupNotLoaded');
            return false;
        }

        let [group] = await load(groupId, true);

        if (!group) {
            utils.notify(browser.i18n.getMessage('groupNotFound'), 7000, 'groupNotFound');
            return false;
        }

        if (group.isArchive) {
            utils.notify(browser.i18n.getMessage('groupIsArchived', group.title), 7000, 'groupIsArchived');
            return false;
        }

        if (group.tabs.some(utils.isTabCanNotBeHidden)) {
            utils.notify(browser.i18n.getMessage('notPossibleSwitchGroupBecauseSomeTabShareMicrophoneOrCamera'));
            return false;
        }

        await BG.loadingBrowserAction(true, windowId);

        await cache.removeWindowSession(windowId);

        let tabs = await Tabs.get(windowId, false, true);
        // remove tabs without group
        tabs = tabs.filter(tab => !tab.groupId);

        if (tabs.length) {
            await BG.browser.tabs.show(tabs.map(utils.keyId));
            await Tabs.setActive(undefined, tabs);
        } else {
            await Tabs.createTempActiveTab(windowId, false);
        }

        if (group.tabs.length) {
            let tabIds = group.tabs.map(utils.keyId);

            BG.addExcludeTabIds(tabIds);
            await BG.browser.tabs.hide(tabIds);
            BG.removeExcludeTabIds(tabIds);

            if (BG.options.discardTabsAfterHide && !group.dontDiscardTabsAfterHideThisGroup) {
                await Tabs.discard(tabIds);
            }
        }

        BG.updateBrowserActionData(null, windowId);

        BG.updateMoveTabMenus();

        BG.sendMessage({
            action: 'group-unloaded',
            groupId,
            windowId,
        });

        BG.sendExternalMessage({
            action: 'group-unloaded',
            groupId,
            windowId,
        });

        return true;
    }

    async function archiveToggle(groupId) {
        await BG.loadingBrowserAction();

        let [group, groups] = await load(groupId, true);

        if (group.isArchive) {
            group.isArchive = false;

            await BG.createTabsSafe(setNewTabsParams(group.tabs, group));
        } else {
            group.isArchive = true;

            let tabIds = group.tabs.map(utils.keyId);

            group.tabs = Tabs.prepareForSave(group.tabs, false, true, true);

            let groupWindowId = cache.getWindowId(group.id);

            if (groupWindowId) {
                await cache.removeWindowSession(groupWindowId);
                await Tabs.createTempActiveTab(groupWindowId, false);
            }

            if (tabIds.length) {
                BG.addExcludeTabIds(tabIds);
                await Tabs.remove(tabIds);
                BG.removeExcludeTabIds(tabIds);
            }

            if (group.isMain) {
                group.isMain = false;
                utils.notify(browser.i18n.getMessage('thisGroupWasMain'), 7000);
            }
        }

        BG.sendExternalMessage({
            action: 'group-updated',
            group: mapForExternalExtension(group),
        });

        await save(groups, true);

        BG.loadingBrowserAction(false);

        BG.updateMoveTabMenus();
    }

    function mapForExternalExtension(group) {
        return {
            id: group.id,
            title: utils.getGroupTitle(group, group.isArchive ? '' : 'withActiveGroup'),
            isArchive: group.isArchive,
            iconUrl: utils.getGroupIconUrl(group),
            contextualIdentity: containers.get(group.newTabContainer),
        };
    }

    function getNewTabParams({id, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen}) {
        return {groupId: id, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen};
    }

    function setNewTabsParams(tabs, group) {
        let newTabParams = getNewTabParams(group);

        return tabs.map(tab => Object.assign(tab, newTabParams));
    }

    async function getNextTitle() {
        let {lastCreatedGroupPosition} = await storage.get('lastCreatedGroupPosition');
        return utils.createGroupTitle(null, lastCreatedGroupPosition + 1);
    }

    function isCatchedUrl(url, catchTabRules) {
        return catchTabRules
            .split(/\s*\n\s*/)
            .map(regExpStr => regExpStr.trim())
            .filter(Boolean)
            .some(function(regExpStr) {
                try {
                    return new RegExp(regExpStr).test(url);
                } catch (e) {};
            });
    }

    function getCatchedForTab(groups, currentGroup, {cookieStoreId, url}) {
        groups = groups.filter(group => !group.isArchive);

        let destGroup = groups.find(function({catchTabContainers, catchTabRules}) {
            if (catchTabContainers.includes(cookieStoreId)) {
                return true;
            }

            if (catchTabRules && isCatchedUrl(url, catchTabRules)) {
                return true;
            }
        });

        if (destGroup) {
            if (destGroup.id === currentGroup.id) {
                return false;
            }

            return destGroup;
        }

        if (!currentGroup.moveToMainIfNotInCatchTabRules || !currentGroup.catchTabRules) {
            return false;
        }

        let mainGroup = groups.find(group => group.isMain);

        if (!mainGroup || mainGroup.id === currentGroup.id) {
            return false;
        }

        return mainGroup;
    }

    function isNeedBlockBeforeRequest(groups) {
        return groups.some(function({isArchive, catchTabContainers, catchTabRules, ifDifferentContainerReOpen, newTabContainer}) {
            if (isArchive) {
                return false;
            }

            if (catchTabContainers.length || catchTabRules) {
                return true;
            }

            if (ifDifferentContainerReOpen) {
                return true;
            }

            return newTabContainer !== DEFAULT_COOKIE_STORE_ID;
        });
    }

    window.Groups = {
        load,
        save,
        create,
        add,
        remove,
        update,
        move,
        sort,
        unload,
        archiveToggle,
        mapForExternalExtension,
        getNewTabParams,
        setNewTabsParams,
        getNextTitle,
        getCatchedForTab,
        isNeedBlockBeforeRequest,
    };

})();
