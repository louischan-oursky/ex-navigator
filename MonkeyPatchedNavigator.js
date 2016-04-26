import React from 'react';
import {
  Dimensions,
  Navigator,
} from 'react-native';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SCREEN_HEIGHT = Dimensions.get('window').height;

var AnimationsDebugModule = require('NativeModules').AnimationsDebugModule;
var invariant = require('fbjs/lib/invariant');

class MonkeyPatchedNavigator extends Navigator {
  constructor(props) {
    super(props);
    // patch _transitionTo
    this._transitionTo = (destIndex, velocity, jumpSpringTo, cb) => {
      if (destIndex === this.state.presentedIndex) {
        return;
      }
      if (this.state.transitionFromIndex !== null) {
        this.state.transitionQueue.push({
          destIndex,
          velocity,
          cb,
        });
        return;
      }
      this.state.transitionFromIndex = this.state.presentedIndex;
      this.state.presentedIndex = destIndex;
      this.state.transitionCb = cb;
      this._onAnimationStart();
      if (AnimationsDebugModule) {
        AnimationsDebugModule.startRecordingFps();
      }
      var sceneConfig = this.state.sceneConfigStack[this.state.transitionFromIndex] ||
        this.state.sceneConfigStack[this.state.presentedIndex];
      invariant(
        sceneConfig,
        'Cannot configure scene at index ' + this.state.transitionFromIndex
      );
      if (jumpSpringTo != null) {
        this.spring.setCurrentValue(jumpSpringTo);
      }
      this.spring.setOvershootClampingEnabled(true);
      this.spring.getSpringConfig().friction = sceneConfig.springFriction;
      this.spring.getSpringConfig().tension = sceneConfig.springTension;
      let v = velocity || sceneConfig.defaultTransitionVelocity;
      if (sceneConfig.minimumTransitionVelocity && v < sceneConfig.minimumTransitionVelocity) {
        v = sceneConfig.minimumTransitionVelocity;
      }
      this.spring.setVelocity(v);
      this.spring.setEndValue(1);
    };

    // patch _matchGestureAction
    this._matchGestureAction = (eligibleGestures, gestures, gestureState) => {
      if (!gestures || !eligibleGestures || !eligibleGestures.some) {
        return null;
      }
      var matchedGesture = null;
      eligibleGestures.some((gestureName, gestureIndex) => {
        var gesture = gestures[gestureName];
        if (!gesture) {
          return;
        }
        if (gesture.overswipe == null && this._doesGestureOverswipe(gestureName)) {
          // cannot swipe past first or last scene without overswiping
          return false;
        }
        var isTravelVertical = gesture.direction === 'top-to-bottom' || gesture.direction === 'bottom-to-top';
        var isTravelInverted = gesture.direction === 'right-to-left' || gesture.direction === 'bottom-to-top';

        // FIXME: village specific changes
        var currentLoc;
        if (gestureState.x0 === 0 && gestureState.y0 === 0) {
          currentLoc = isTravelVertical ? gestureState.moveY : gestureState.moveX;
        } else {
          currentLoc = isTravelVertical ? gestureState.y0 : gestureState.x0;
        }
        // FIXME: village specific changes

        var travelDist = isTravelVertical ? gestureState.dy : gestureState.dx;
        var oppositeAxisTravelDist =
          isTravelVertical ? gestureState.dx : gestureState.dy;
        var edgeHitWidth = gesture.edgeHitWidth;
        if (isTravelInverted) {
          currentLoc = -currentLoc;
          travelDist = -travelDist;
          oppositeAxisTravelDist = -oppositeAxisTravelDist;
          edgeHitWidth = isTravelVertical ?
            -(SCREEN_HEIGHT - edgeHitWidth) :
            -(SCREEN_WIDTH - edgeHitWidth);
        }
        var moveStartedInRegion = gesture.edgeHitWidth == null ||
          currentLoc < edgeHitWidth;
        if (!moveStartedInRegion) {
          return false;
        }
        var moveTravelledFarEnough = travelDist >= gesture.gestureDetectMovement;
        if (!moveTravelledFarEnough) {
          return false;
        }
        var directionIsCorrect = Math.abs(travelDist) > Math.abs(oppositeAxisTravelDist) * gesture.directionRatio;
        if (directionIsCorrect) {
          matchedGesture = gestureName;
          return true;
        } else {
          this._eligibleGestures = this._eligibleGestures.slice().splice(gestureIndex, 1);
        }
      });
      return matchedGesture || null;
    };
  }
}

module.exports = MonkeyPatchedNavigator;
