// PORCH-057: the owner console's tab grouping. Tab grouping is the builder's
// call within the shipped surfaces; the acceptance contract pins REACHABILITY,
// not the grouping, so this module is the model of record: the console renders
// its tabs from this list, and the co-located test pins that every shipped
// console capability maps to exactly one tab — a grouping edit cannot silently
// strand an owner action. Pure data, no DOM, no React import: node --test
// loads it without a loader.
export const consoleTabs = [
	{ id: 'invitations', label: 'Invitations', sections: ['Invitations'] },
	{ id: 'members', label: 'Members', sections: ['Members', 'Your devices', 'Member devices', 'Device links sent'] },
	{ id: 'storage', label: 'Storage', sections: ['Space and limits', 'Media storage'] },
	{ id: 'updates', label: 'Updates', sections: ['Updates'] },
	{ id: 'activity', label: 'Activity', sections: ['Recent activity'] },
];

/** Every capability the console ships today, mapped to the tab (or to
 * 'chrome' — reachable from the console itself, outside any single tab)
 * that must keep it reachable. The keys are the reviewer-facing vocabulary
 * of the task's reachability list. */
export const consoleCapabilities = {
	// Invitations tab
	issueJoinLink: 'invitations',
	revokeInvite: 'invitations',
	readInviteStatus: 'invitations',
	// Members tab
	readMemberRoster: 'members',
	setMemberRole: 'members',
	revokeMemberAccess: 'members',
	purgeMemberAndPosts: 'members',
	sendDeviceLink: 'members',
	withdrawDeviceLink: 'members',
	readOwnDeviceRegistrations: 'members',
	revokeDevice: 'members',
	readMemberDevices: 'members',
	revokeAnyDevice: 'members',
	// Storage tab
	readDiskStatus: 'storage',
	editStorageCeiling: 'storage',
	editRetentionDays: 'storage',
	editMediaRoot: 'storage',
	downloadArchive: 'storage',
	readBackupStatus: 'storage',
	// Updates tab
	readReleaseStatus: 'updates',
	applyUpdate: 'updates',
	// Activity tab
	readAuditLog: 'activity',
	// Console chrome, outside the tabs
	backToProfile: 'chrome',
};