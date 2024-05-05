const SteamCommunity = require('../index.js');

const Helpers = require('./helpers.js');

/**
 * Retrieves your account's Steam Web API key, if you already have one. If you don't yet have one, this will fail.
 * To create a Web API key, use `createWebApiKey()`.
 *
 * @param {null|function} unused - No longer used, kept for backward compatibility. You can omit this parameter and pass
 *    your callback directly as the first parameter if you want.
 * @param {function} callback
 */
SteamCommunity.prototype.getWebApiKey = function(unused, callback) {
	if (typeof unused == 'function') {
		callback = unused;
	}

	this.httpRequest({
		uri: 'https://steamcommunity.com/dev/apikey?l=english',
		followRedirect: false
	}, (err, response, body) => {
		if (err) {
			callback(err);
			return;
		}

		if (body.match(/You must have a validated email address to create a Steam Web API key./)) {
			return callback(new Error('You must have a validated email address to create a Steam Web API key.'));
		}

		if (body.match(/Your account requires (<a [^>]+>)?Steam Guard Mobile Authenticator/)) {
			return callback(new Error('Steam Guard Mobile Authenticator required to create a Steam Web API key'));
		}

		if (body.match(/<h2>Access Denied<\/h2>/)) {
			return callback(new Error('Access Denied'));
		}

		let match = body.match(/<p>Key: ([0-9A-F]+)<\/p>/);
		if (match) {
			// We already have an API key registered
			callback(null, match[1]);
		} else {
			callback(new Error('No API key created for this account'));
		}
	}, "steamcommunity");
};

/**
 * Revokes your account's Steam Web API key.
 * @param {function} callback
 */
SteamCommunity.prototype.revokeWebApiKey = function(callback) {
	this.httpRequestPost({
		uri: "https://steamcommunity.com/dev/revokekey",
		form: {
			Revoke: "Revoke My Steam Web API Key",
			sessionid: this.getSessionID()
		},
		json: true
	}, (err, response, body) => {
		if (err) {
			callback(err);
			return;
		}

		if(response.statusCode != 302) {
			callback(new Error("HTTP error " + response.statusCode));
			return;
		}

		callback(null);
	}, "steamcommunity");
};

/**
 * @typedef CreateApiKeyOptions
 * @property {string} domain - The domain to associate with your API key
 * @property {string} [requestID] - If finalizing an existing create request, include the request ID
 * @property {string|Buffer} [identitySecret] - If you pass your identity_secret here, then steamcommunity will
 *   internally handle accepting any confirmations.
 */

/**
 * @typedef CreateApiKeyResponse
 * @property {boolean} confirmationRequired
 * @property {string} [apiKey] - If creating your API key succeeded, this is the new key
 * @property {CreateApiKeyOptions} [finalizeOptions] - If confirmation is required to create a key, then accept the
 *   confirmation, then call createWebApiKey again and pass this whole object for the `options` parameter.
 */

/**
 * @callback createWebApiKeyCallback
 * @param {Error|null} err
 * @param {CreateApiKeyResponse} [result]
 */

/**
 * Starts the process to create a Steam Web API key. When the callback is fired, you will need to approve a mobile
 * confirmation in your app or using getConfirmations().
 *
 * @param {CreateApiKeyOptions} options
 * @param {createWebApiKeyCallback} callback
 */
SteamCommunity.prototype.createWebApiKey = function(options, callback) {
	if (!options.domain) {
		callback(new Error('Passing a domain is required to register an API key'));
		return;
	}

	this.httpRequestPost({
		uri: 'https://steamcommunity.com/dev/requestkey',
		form: {
			domain: options.domain,
			request_id: options.requestID || '0',
			sessionid: this.getSessionID(),
			agreeToTerms: 'true'
		},
		json: true
	}, (err, res, body) => {
		if (err) {
			callback(err);
			return;
		}

		// body.requires_confirmation is 1/0, but the Steam website doesn't check this value and instead only checks the
		// value of `success`. So let's just do that.

		// This is a mess. I'm glad we have promises and await now.

		switch (body.success) {
			case SteamCommunity.EResult.OK:
				if (body.api_key) {
					callback(null, {confirmationRequired: false, apiKey: body.api_key});
					return;
				}

				// It's not been observed that we get result OK without api_key included, but the Steam website doesn't
				// use this value so let's be safe just in case it disappears in the future.
				this.getWebApiKey((err, key) => {
					if (err) {
						callback(err);
						return;
					}

					callback(null, {confirmationRequired: false, apiKey: key});
				});
				return;

			case SteamCommunity.EResult.Pending:
				let finalizeOptions = {
					domain: options.domain,
					requestID: body.request_id || options.requestID
				}

				if (options.identitySecret) {
					this.acceptConfirmationForObject(options.identitySecret, finalizeOptions.requestID, (err) => {
						if (err) {
							callback(err);
						} else {
							this.createWebApiKey(finalizeOptions, callback);
						}
					});
					return;
				}

				callback(null, {
					confirmationRequired: true,
					finalizeOptions: finalizeOptions
				});
				return;

			default:
				callback(Helpers.eresultError(body.success));
		}
	});
};

/**
 * @deprecated No longer works. Will be removed in a future release.
 * @param {function} callback
 */
SteamCommunity.prototype.getWebApiOauthToken = function(callback) {
	if (this.oAuthToken) {
		return callback(null, this.oAuthToken);
	}

	callback(new Error('This operation requires an OAuth token, which is no longer issued by Steam.'));
};

/**
 * Sets an access_token generated by steam-session using EAuthTokenPlatformType.MobileApp.
 * Required for some operations such as 2FA enabling and disabling.
 * This will throw an Error if the provided token is not valid, was not generated for the MobileApp platform, is expired,
 * or does not belong to the logged-in user account.
 *
 * @param {string} token
 */
SteamCommunity.prototype.setMobileAppAccessToken = function(token) {
	if (!this.steamID) {
		throw new Error('Log on to steamcommunity before setting a mobile app access token');
	}

	let decodedToken = Helpers.decodeJwt(token);

	if (!decodedToken.iss || !decodedToken.sub || !decodedToken.aud || !decodedToken.exp) {
		throw new Error('Provided value is not a valid Steam access token');
	}

	if (decodedToken.iss == 'steam') {
		throw new Error('Provided token is a refresh token, not an access token');
	}

	if (decodedToken.sub != this.steamID.getSteamID64()) {
		throw new Error(`Provided token belongs to account ${decodedToken.sub}, but we are logged into ${this.steamID.getSteamID64()}`);
	}

	if (decodedToken.exp < Math.floor(Date.now() / 1000)) {
		throw new Error('Provided token is expired');
	}

	if ((decodedToken.aud || []).indexOf('mobile') == -1) {
		throw new Error('Provided token is not valid for MobileApp platform type');
	}

	this.mobileAccessToken = token;
};

/**
 * Verifies that the mobile access token we already have set is still valid for current login.
 *
 * @private
 */
SteamCommunity.prototype._verifyMobileAccessToken = function() {
	if (!this.mobileAccessToken) {
		// No access token, so nothing to do here.
		return;
	}

	let decodedToken = Helpers.decodeJwt(this.mobileAccessToken);

	let isTokenInvalid = decodedToken.sub != this.steamID.getSteamID64()    // SteamID doesn't match
		|| decodedToken.exp < Math.floor(Date.now() / 1000);                      // Token is expired

	if (isTokenInvalid) {
		delete this.mobileAccessToken;
	}
};
